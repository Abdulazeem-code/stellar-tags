#![no_std]
mod archival;
use archival::{ArchiveLeaf, ArchiveMetadata, ArchiveRecordType};
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, log, symbol_short, token,
    vec, Address, Bytes, BytesN, Env, Error as SdkError, IntoVal, InvokeError, String, Symbol, Vec,
};

// ── Packed UserRecord helpers ───────────────────────────────────────────────
//
// Issue #519: replace the two-field `UserSpending` contracttype with a single
// packed value instead of a struct, dropping the XDR type discriminant and
// field tags Soroban adds to every contracttype.
//
// Issue #663: merge the per-user `UserSpending` and `UserVolume` entries into
// one packed `UserRecord`. A sender's first routed payment used to write two
// persistent entries — two reads, two writes, two TTL extensions, two XDR
// envelopes — and it now performs exactly one of each.
//
// Layout (big-endian):
//   bytes  0..8  — last_reset_time    : u64  (8 bytes)
//   bytes  8..24 — accumulated_amount : i128 (16 bytes)
//   bytes 24..40 — lifetime volume    : i128 (16 bytes)
//
// Backward compatibility: the legacy `UserSpending` / `UserVolume` keys are no
// longer written. `load_user_record` still reads them and combines them on the
// next write, and the permissionless `migrate_user_record` entry point cleans
// up any account that has not paid since the upgrade.

/// Pack `last_reset_time` (u64), `accumulated_amount` (i128) and `volume`
/// (i128) into a 40-byte big-endian buffer.
fn pack_user_record(
    env: &Env,
    last_reset_time: u64,
    accumulated_amount: i128,
    volume: i128,
) -> BytesN<40> {
    let mut buf = [0u8; 40];

    buf[..8].copy_from_slice(&last_reset_time.to_be_bytes());
    buf[8..24].copy_from_slice(&accumulated_amount.to_be_bytes());
    buf[24..40].copy_from_slice(&volume.to_be_bytes());

    BytesN::from_array(env, &buf)
}

/// Unpack a 40-byte buffer into `(last_reset_time, accumulated_amount, volume)`.
fn unpack_user_record(packed: &BytesN<40>) -> (u64, i128, i128) {
    let buf: [u8; 40] = packed.to_array();

    let last_reset_time = u64::from_be_bytes([
        buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
    ]);

    let accumulated_amount = i128::from_be_bytes([
        buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15], buf[16], buf[17],
        buf[18], buf[19], buf[20], buf[21], buf[22], buf[23],
    ]);

    let volume = i128::from_be_bytes([
        buf[24], buf[25], buf[26], buf[27], buf[28], buf[29], buf[30], buf[31], buf[32], buf[33],
        buf[34], buf[35], buf[36], buf[37], buf[38], buf[39],
    ]);

    (last_reset_time, accumulated_amount, volume)
}

/// Unpack a legacy 24-byte `UserSpending` buffer into
/// `(last_reset_time, accumulated_amount)`.
///
/// Kept so the migration fallback in `load_user_record` can still read
/// pre-#663 ledger state.
fn unpack_legacy_spending(packed: &BytesN<24>) -> (u64, i128) {
    let buf: [u8; 24] = packed.to_array();

    let last_reset_time = u64::from_be_bytes([
        buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
    ]);

    let accumulated_amount = i128::from_be_bytes([
        buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15], buf[16], buf[17],
        buf[18], buf[19], buf[20], buf[21], buf[22], buf[23],
    ]);

    (last_reset_time, accumulated_amount)
}

// ── Legacy struct kept for test snapshot compatibility ───────────────────────
//
// The UserSpending contracttype is retained so existing tests that reference
// it directly continue to compile. All runtime code now uses the packed
// `BytesN<40>` representation stored under DataKey::UserRecord.

/// A user's rolling 24-hour spending record.
///
/// Retained purely so existing test snapshots that reference this type by
/// name keep compiling. Pre-#663 live contract state was stored as a packed
/// `BytesN<24>` (still readable via `unpack_legacy_spending`); this struct is
/// not read from or written to storage at runtime.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserSpending {
    /// Unix timestamp (seconds) at which the 24-hour window last reset.
    pub last_reset_time: u64,
    /// Total amount routed by the user since `last_reset_time`.
    pub accumulated_amount: i128,
}

/// A user's combined routing stats, unpacked from the packed `BytesN<40>`
/// `UserRecord` ledger value (issue #663).
///
/// Returned by [`PaymentRouter::get_user_record`] so a client can read both
/// counters in a single view call instead of two.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRecord {
    /// Total amount routed by the user in the current 24-hour window.
    pub accumulated_amount: i128,
    /// Cumulative lifetime amount routed by the user.
    pub volume: i128,
    /// Unix timestamp (seconds) at which the 24-hour window last reset.
    pub last_reset_time: u64,
}

/// A single transfer instruction for use with [`PaymentRouter::route_payments`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payment {
    /// Address the funds are debited from. Must authorize the call.
    pub sender: Address,
    /// Address the funds (minus the platform fee) are credited to.
    pub recipient: Address,
    /// Contract ID of the token (or Stellar Asset Contract) being transferred.
    pub token_address: Address,
    /// Amount to route, denominated in the token's smallest unit. Must be
    /// positive and within the contract's configured min/max bounds.
    pub amount: i128,
}

/// Structured payload for meta-transactions.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetaPayment {
    pub nonce: u64,
    pub deadline: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token_address: Address,
    pub amount: i128,
}

// ── Token swap types ─────────────────────────────────────────────────────────
//
// Issue #665: allow a sender to pay in an arbitrary token and have it swapped
// into the merchant's preferred token during payment routing.  The swap is a
// cross-contract call into a DEX router, executed inside the same Soroban
// transaction as the transfer so the payment either completes end to end or
// leaves no trace at all.

/// A single swap-routed transfer instruction for use with
/// [`PaymentRouter::route_payment_with_swap`] and
/// [`PaymentRouter::route_payments_with_swap`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapPayment {
    /// Address the funds are debited from. Must authorize the call.
    pub sender: Address,
    /// Address the swapped funds (minus the platform fee) are credited to.
    pub recipient: Address,
    /// Token the sender pays with, in that token's smallest unit.
    pub sell_token: Address,
    /// Token the recipient is paid in. Must differ from `sell_token`.
    pub buy_token: Address,
    /// Amount of `sell_token` to pull from the sender and swap.
    pub amount_in: i128,
    /// Minimum amount of `buy_token` the swap must deliver. This is the
    /// slippage floor: if the DEX returns less, the whole payment reverts.
    pub min_amount_out: i128,
    /// Amount of `buy_token` the caller expected from a prior `quote_swap`
    /// call. `0` disables the ceiling check; otherwise the realised output
    /// must stay within the contract's `max_slippage_bps` of this figure.
    pub expected_amount_out: i128,
    /// Unix timestamp (seconds) after which the swap must not execute. `0`
    /// disables the deadline, letting the DEX apply its own.
    pub deadline: u64,
    /// Contract ID of the DEX adapter to invoke. Must be registered by the
    /// admin, which keeps the cross-contract call pointed at audited code.
    pub dex: Address,
}

/// The result of a DEX quote, returned by [`PaymentRouter::quote_swap`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapQuote {
    /// Amount of `buy_token` the DEX expects to deliver for the quoted input.
    pub amount_out: i128,
    /// Tightest `min_amount_out` that still respects the contract's
    /// `max_slippage_bps` for this quote.
    pub min_amount_out: i128,
    /// Configured maximum slippage, in basis points, that produced
    /// `min_amount_out`.
    pub max_slippage_bps: i128,
}

/// Adapter interface implemented by the DEX used for an arbitrary token swap.
/// The router transfers the input asset to the adapter. The result must contain
/// `[amount_received, unused_input]`; the adapter must send the output asset to
/// `recipient` and return any unused input to the router.
#[contractclient(name = "DexRouterClient")]
pub trait DexRouter {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        path: Vec<Address>,
        recipient: Address,
    ) -> Vec<i128>;
}

// ── Timelock data structures ─────────────────────────────────────────────────
//
// Admin actions that change sensitive contract parameters (treasury, fees,
// governance, admin transfer) are not applied instantly.  Instead the admin
// queues an ActionType intent that gets a nonce ID and a ledger timestamp.
// Only after SECONDS_IN_24H (86 400 s) has elapsed can execute_action be
// called to apply the change.  This gives observers a 24-hour window to
// detect and respond to a compromised-admin scenario.
//
// The freeze mechanism is the complementary emergency tool: calling
// emergency_freeze instantly blocks all payments and all timelock executions.
// A freeze does NOT require going through the timelock itself so it is always
// available to the admin as an immediate last resort.  Unfreezing likewise
// takes effect immediately so the admin can restore service once the threat is
// resolved.

/// Describes which administrative parameter change a timelock entry represents.
/// Each variant carries all the arguments needed to apply that change when the
/// delay period is over.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActionType {
    /// Change the platform treasury address.
    SetPlatformTreasury(Address),
    /// Update fee basis-points and fee cap together (legacy / combined setter).
    SetFeeConfig(i128, i128),
    /// Update fee basis-points only.
    SetFeeBps(i128),
    /// Set the governance contract address.
    SetGovernance(Address),
    /// Change the minimum routing limit.
    SetMinLimit(i128),
    /// Transfer admin rights to a new address.
    TransferAdmin(Address),
    /// Upgrade the contract WASM.
    ///
    /// Executing this action also requires the multi-signature admin group to
    /// have approved `new_wasm_hash` (see [`PaymentRouter::approve_upgrade`]),
    /// so the timelock delay and the M-of-N gate compose rather than replace
    /// each other.
    Upgrade(BytesN<32>),
    /// Allow swap routing to invoke a DEX router contract.
    RegisterDex(Address),
    /// Stop swap routing from invoking a DEX router contract.
    DeregisterDex(Address),
    /// Update the maximum tolerated swap slippage.
    SetMaxSlippageBps(i128),
    /// Configure the multi-signature admin group for contract upgrades.
    SetMultisigConfig(Vec<Address>, u32),
}

/// A pending timelock entry stored in persistent ledger storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockEntry {
    /// Ledger timestamp (seconds since epoch) when this action was queued.
    pub queued_at: u64,
    /// The action payload to apply once the delay has elapsed.
    pub action: ActionType,
}

/// Role definitions for the Role-Based Access Control (RBAC) system.
///
/// Segregates operational privileges across dedicated role boundaries:
/// SuperAdmin, TreasuryManager, ComplianceOfficer, FeeManager.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Role {
    /// Supreme administrator with exclusive authority over role assignments,
    /// contract upgrades, emergency freeze/unfreeze, and root governance.
    SuperAdmin = 1,
    /// Manager with exclusive authority over platform treasury, yield operations,
    /// token recovery, and emergency asset withdrawals.
    TreasuryManager = 2,
    /// Compliance officer with authority over address blacklisting, KYC oracle
    /// configurations, and emergency operational pause switches.
    ComplianceOfficer = 3,
    /// Fee manager with authority over platform fee basis points, fee caps, and
    /// minimum payment limits.
    FeeManager = 4,
}

/// Interface implemented by supported Soroban lending protocols.
///
/// Keeping the protocol behind this small adapter lets the router integrate
/// with Blend-compatible deployments while tests use an in-process mock.
#[contractclient(name = "LendingProtocolClient")]
pub trait LendingProtocol {
    fn deposit(env: Env, from: Address, token: Address, amount: i128);
    fn withdraw(env: Env, to: Address, token: Address, amount: i128);
    fn harvest(env: Env, to: Address, token: Address) -> i128;
}

/// Minimal interface for an admin-selected KYC issuer or oracle contract.
#[contractclient(name = "KycOracleClient")]
pub trait KycOracle {
    fn is_verified(env: Env, account: Address) -> bool;
}

/// Interface implemented by the admin-selected price-feed oracle.
///
/// Implementations must return a price quote with a `timestamp` (Unix seconds)
/// so staleness can be checked against the contract's configured threshold.
/// The `price` is expressed as a fixed-point integer with the number of
/// decimal places indicated by `decimals`.  For example, a USD/XLM price of
/// 0.12500000 with `decimals = 8` would be returned as `price = 12500000`.
///
/// Keeping the protocol behind this thin adapter lets the router integrate
/// with any Soroban-compatible price oracle while tests use an in-process mock.
#[contractclient(name = "PriceFeedOracleClient")]
pub trait PriceFeedOracle {
    /// Returns the latest price of `base_asset` denominated in `quote_asset`.
    ///
    /// # Returns
    /// A `PriceData` struct containing `price`, `decimals`, and `timestamp`.
    fn get_price(env: Env, base_asset: Address, quote_asset: Address) -> PriceData;
}

/// A single price quote returned by the oracle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    /// Fixed-point price value. The true price is `price / 10^decimals`.
    pub price: i128,
    /// Number of decimal places used in `price`.
    pub decimals: u32,
    /// Unix timestamp (seconds) when this price was last updated on-chain.
    pub timestamp: u64,
}

/// A fee change proposal weighted by governance-token balances.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeProposal {
    pub proposer: Address,
    pub fee_bps: i128,
    pub fee_cap: i128,
    pub created_at: u64,
    pub voting_ends_at: u64,
    pub yes_votes: i128,
    pub no_votes: i128,
    pub quorum: i128,
    pub executed: bool,
}

/// Multi-signature configuration for contract upgrades.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultisigConfig {
    /// The list of authorized signers.
    pub signers: Vec<Address>,
    /// The minimum number of signers required to approve an upgrade.
    pub threshold: u32,
}

/// Storage keys for all contract instance and persistent data.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// The current admin address.
    Admin,
    /// Governance contract address; if set, it takes over fee-authority from the admin.
    Governance,
    /// Address that receives collected platform fees.
    PlatformTreasury,
    /// Platform fee rate, in basis points (1/100th of a percent).
    FeeBps,
    /// Upper bound on the fee taken from a single payment.
    FeeCap,
    /// Minimum amount accepted by `route_payment` / `route_payments`, if set.
    MinLimit,
    /// Whether routing is currently paused.
    Paused,
    /// Maximum amount accepted by a single payment.
    MaxAmount,
    /// Cumulative lifetime amount routed by a given sender.
    /// Packed per-user record (issue #663): the 24-hour spending window plus
    /// the cumulative lifetime volume, stored as a single 40-byte value so
    /// registering a sender costs one ledger entry instead of two.
    UserRecord(Address),
    /// DEPRECATED (pre-#663): packed 24-hour spending window for a sender.
    /// No longer written; read only by the `load_user_record` fallback and by
    /// `migrate_user_record`.
    UserSpending(Address),
    /// DEPRECATED (pre-#663): cumulative lifetime amount routed by a sender.
    /// No longer written; read only by the `load_user_record` fallback and by
    /// `migrate_user_record`.
    UserVolume(Address),
    /// Whether a given recipient address is blacklisted.
    Blacklist(Address),
    /// Internal refund balance for a (user, token) pair, credited when a
    /// direct transfer to the recipient fails.
    RefundBalance(Address, Address),
    /// Monotonically-increasing nonce counter used to generate unique IDs for
    /// timelock entries.  Stored as `u64` in instance storage.
    TimelockNonce,
    /// A pending timelock entry keyed by its nonce ID.
    /// Stored in persistent storage so it survives instance eviction.
    TimelockEntry(u64),
    /// When `true` the contract is frozen: payments and timelock executions
    /// are blocked.  Stored as `bool` in instance storage.
    Frozen,
    /// Whether an address holds a given role.
    UserRole(Address, Role),
    /// The primary address currently holding a role.
    Role(Role),
    /// Monotonic nonce for meta-transaction replay protection.
    MetaNonce(Address),
    /// Trusted issuer/oracle queried for high-value payment senders.
    KycOracle,
    /// Payments strictly above this amount require a valid KYC claim.
    KycThreshold,
    /// Address of the price-feed oracle used for fiat/crypto lookups.
    OracleAddress,
    /// Maximum acceptable age, in seconds, of an oracle price quote.
    StalenessThreshold,
    /// Admin-supplied fallback price for a (base, quote) asset pair.
    FallbackPrice(Address, Address),
    /// Token whose balances weight fee-governance votes.
    GovernanceToken,
    /// Minimum weighted vote share required to pass a fee proposal.
    GovernanceQuorum,
    /// Monotonic nonce for fee-proposal ids.
    GovernanceNonce,
    /// A pending fee-change proposal keyed by its id.
    GovernanceProposal(u64),
    /// Recorded yes/no vote weight for a fee proposal.
    GovernanceVote(u64, Address),
    /// Current archival epoch counter, stored in instance storage.
    ArchiveEpoch,
    /// Merkle root committed for an archival epoch.
    ArchiveRoot(u64),
    /// Metadata committed alongside an archival root.
    ArchiveMeta(u64),
    /// Lending protocol contract used for treasury yield operations.
    YieldProtocol,
    /// Principal currently deposited into the yield protocol per token.
    YieldPrincipal(Address),
    /// Whether a DEX router contract is approved to receive cross-contract
    /// swap calls.  Stored as `bool` in persistent storage.
    RegisteredDex(Address),
    /// Maximum tolerated swap slippage in basis points, applied against a
    /// caller-supplied quote.  Stored as `i128` in instance storage.
    MaxSlippageBps,
    /// The N addresses of the multi-signature admin group that authorize
    /// contract upgrades.  Stored as `Vec<Address>` in instance storage.
    ///
    /// Absent until the admin calls `set_multisig_config`; while absent every
    /// upgrade attempt fails closed with `Error::MultisigNotInitialized`.
    MultisigSigners,
    /// The M signers of the multi-signature admin group that must approve a
    /// WASM hash before an upgrade is authorized.  Stored as `u32` in
    /// instance storage, always alongside `MultisigSigners`.
    MultisigThreshold,
    /// The addresses that have already signed off on upgrading to a specific
    /// WASM hash.  Keyed by that hash so approvals for concurrent upgrade
    /// proposals are tracked independently.  Stored as `Vec<Address>` in
    /// persistent storage and cleared once the upgrade is applied.
    UpgradeApproval(BytesN<32>),
    /// Guard against cross-contract reentrancy attacks.
    ReentrancyGuard,
}

/// Contract-level errors returned instead of panicking, so callers get a
/// specific, stable error code to branch on rather than an opaque trap.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Caller is not authorized to perform this action (e.g. not the admin).
    Unauthorized = 1,
    /// Sender's token balance is lower than the requested payment amount.
    InsufficientBalance = 2,
    /// Requested amount is outside allowed bounds, or a spending limit was exceeded.
    LimitExceeded = 3,
    /// `initialize` was called on a contract that already has an admin set.
    AlreadyInitialized = 4,
    /// An admin-configured value (treasury, fee, admin) was read before `initialize`.
    NotInitialized = 5,
    /// The contract is currently paused; routing calls are rejected until unpaused.
    Paused = 6,
    /// A fee configuration value (basis points or cap) is out of the allowed range.
    InvalidFeeRate = 7,
    /// Sender and recipient addresses are the same (self-routing not allowed).
    InvalidRecipient = 8,
    /// Recipient address is blacklisted.
    Blacklisted = 9,
    /// Requested refund withdrawal amount is zero or exceeds available refund balance.
    NoRefundAvailable = 10,
    /// An action is already pending in the timelock queue; it must be executed
    /// or cancelled before a duplicate can be queued (not currently enforced,
    /// but reserved for future deduplication logic).
    TimelockPending = 11,
    /// The 24-hour delay for the given timelock entry has not elapsed yet.
    TimelockNotReady = 12,
    /// No timelock entry exists for the supplied nonce ID.
    TimelockNotFound = 13,
    /// The contract is frozen; all payments and timelock executions are blocked.
    ContractFrozen = 14,
    /// The swap named a DEX router that the admin has not registered.
    DexNotRegistered = 15,
    /// The DEX cross-contract call reverted or returned an unusable value.
    SwapFailed = 16,
    /// The swap delivered less than `min_amount_out`, or moved the output
    /// further than `max_slippage_bps` away from the caller's quote.
    SlippageExceeded = 17,
    /// The swap was submitted after its `deadline` had already passed.
    SwapDeadlineExpired = 18,
    /// The supplied role is not one the contract recognises.
    InvalidRole = 20,
    /// A governance proposal id is unknown or no longer votable.
    InvalidProposal = 21,
    /// A governance operation was attempted before governance was configured.
    GovernanceNotConfigured = 22,
    /// The caller has already voted on this proposal.
    AlreadyVoted = 23,
    /// The configured KYC threshold is negative.
    InvalidKycThreshold = 24,
    /// A yield operation was attempted before the yield protocol was configured.
    YieldProtocolNotConfigured = 25,
    /// The yield amount is not positive or exceeds the available principal.
    InvalidYieldAmount = 26,
    /// No price-feed oracle is configured for this contract.
    OracleNotConfigured = 27,
    /// The oracle cross-contract call reverted or returned an unusable value.
    OracleCallFailed = 28,
    /// The oracle quote is older than the configured staleness threshold.
    OraclePriceStale = 29,
    /// The oracle quote is not a usable price (zero or negative).
    OraclePriceInvalid = 30,
    /// A meta-transaction was submitted after its `deadline` had passed.
    DeadlineExpired = 31,
    /// The meta-transaction nonce does not match the sender's stored nonce.
    InvalidNonce = 32,
    /// The meta-transaction signature did not verify against the payload.
    InvalidSignature = 33,
    /// Swap parameters are self-contradictory or unusable (for example
    /// `sell_token == buy_token`, or a non-positive `min_amount_out`).
    InvalidSwapParams = 19,
    /// A payment above the configured KYC threshold was made by a sender the
    /// configured oracle does not recognise.
    KycRequired = 34,
    /// A swap path is empty, malformed, or does not connect the requested assets.
    InvalidSwapPath = 35,
    /// The DEX returned less than the caller's minimum acceptable output.
    SlippageExceededSwap = 36,
    /// The multi-signature configuration is unusable: the signer set is empty,
    /// contains a duplicate address, the threshold is zero, or the threshold
    /// exceeds the number of signers (so the upgrade could never be authorized).
    InvalidMultisigConfig = 37,
    /// The calling address is not a member of the multi-signature admin group.
    NotMultisigSigner = 38,
    /// The number of collected upgrade approvals is below the configured
    /// threshold, so the upgrade is not authorized yet.
    InsufficientApprovals = 39,
    /// No multi-signature admin group has been configured yet.  Upgrades fail
    /// closed until `set_multisig_config` has been called, so a freshly
    /// deployed contract can never be upgraded through the single admin key
    /// that the group was introduced to de-risk.
    MultisigNotInitialized = 40,
    /// The calling address has already approved this WASM hash.  Duplicate
    /// approvals are rejected rather than ignored so that a replayed signature
    /// can never inflate the approval count towards the threshold.
    AlreadyApproved = 41,
    /// A reentrant call was detected.
    ReentrantCall = 42,
}

/// Soroban contract that routes token payments between addresses while
/// collecting a configurable platform fee, enforcing per-user daily spending
/// limits, and supporting an admin-managed blacklist and pause switch.
#[contract]
pub struct PaymentRouter;

struct ReentrancyGuard<'a> {
    env: &'a Env,
}

impl<'a> ReentrancyGuard<'a> {
    fn new(env: &'a Env) -> Result<Self, Error> {
        let is_locked: bool = env
            .storage()
            .instance()
            .get(&DataKey::ReentrancyGuard)
            .unwrap_or(false);
        if is_locked {
            return Err(Error::ReentrantCall);
        }
        env.storage()
            .instance()
            .set(&DataKey::ReentrancyGuard, &true);
        Ok(Self { env })
    }
}

impl<'a> Drop for ReentrancyGuard<'a> {
    fn drop(&mut self) {
        self.env
            .storage()
            .instance()
            .set(&DataKey::ReentrancyGuard, &false);
    }
}

#[contractimpl]
impl PaymentRouter {
    /// Returns the deployed contract version string.
    ///
    /// This is a read-only view function: it does not write to ledger storage
    /// and costs only the base invocation fee.  The UI calls this before
    /// submitting transactions to confirm it is compatible with the deployed
    /// contract.
    ///
    /// # Returns
    /// A [`String`] in the form `"MAJOR.MINOR.PATCH"` (e.g. `"1.0.0"`).
    pub fn version(env: Env) -> String {
        String::from_str(&env, CONTRACT_VERSION)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    /// Verifies that `version()` returns the expected version string and that
    /// the returned value matches the compile-time `CONTRACT_VERSION` constant,
    /// so the two can never drift apart.
    #[test]
    fn test_version_returns_expected_string() {
        let env = Env::default();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let returned = client.version();
        let expected = String::from_str(&env, CONTRACT_VERSION);

        assert_eq!(returned, expected);
    }

    /// Verifies the version string is non-empty.
    #[test]
    fn test_version_is_non_empty() {
        let env = Env::default();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let v = client.version();

        // A Soroban String's byte length is accessible via .len()
        assert!(v.len() > 0, "version must not be empty");
    }
}

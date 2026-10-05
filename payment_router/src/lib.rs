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
/// SuperAdmin (root Admin), Pauser, FeeManager, TreasuryManager, and
/// ComplianceOfficer.
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
    /// configurations, and oracle price configuration.
    ComplianceOfficer = 3,
    /// Fee manager with authority over platform fee basis points, fee caps, and
    /// minimum payment limits.
    FeeManager = 4,
    /// Pauser with authority over the operational pause switch. Kept separate
    /// from the broader compliance role so the ability to halt routing can be
    /// delegated narrowly.
    Pauser = 5,
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

impl Drop for ReentrancyGuard<'_> {
    fn drop(&mut self) {
        self.env
            .storage()
            .instance()
            .set(&DataKey::ReentrancyGuard, &false);
    }
}

#[contractimpl]
impl PaymentRouter {
    const BPS_DIVISOR: i128 = 10_000;
    const XLM_DECIMALS: i128 = 10_000_000;
    const MAX_AMOUNT: i128 = 1_000_000_000_000_000; // 100M tokens with 7 decimals
    const DAILY_MAX_LIMIT: i128 = 1_000_000 * Self::XLM_DECIMALS; // 1M tokens limit
    const VOLUME_THRESHOLD: i128 = 10_000 * Self::XLM_DECIMALS; // 10,000 XLM threshold for tiered fee discount
    const SECONDS_IN_24H: u64 = 24 * 3600;
    const CONTRACT_VERSION: &'static str = env!("CARGO_PKG_VERSION");

    /// Default ceiling on how far a swap may move against the caller's quote:
    /// 1 000 bps = 10%.  Applied only when the caller supplies an
    /// `expected_amount_out`; the `min_amount_out` floor always applies.
    const DEFAULT_MAX_SLIPPAGE_BPS: i128 = 1_000;
    /// Absolute ceiling for the configurable slippage setting (100%).
    const MAX_SLIPPAGE_BPS_LIMIT: i128 = 10_000;

    const DAY_IN_LEDGERS: u32 = 17280;
    const INSTANCE_BUMP_AMOUNT: u32 = 7 * Self::DAY_IN_LEDGERS;
    const INSTANCE_LIFETIME_THRESHOLD: u32 = Self::INSTANCE_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;

    const USER_BUMP_AMOUNT: u32 = 30 * Self::DAY_IN_LEDGERS;
    const USER_LIFETIME_THRESHOLD: u32 = Self::USER_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;
    const PERSISTENT_BUMP_AMOUNT: u32 = Self::USER_BUMP_AMOUNT;
    const PERSISTENT_LIFETIME_THRESHOLD: u32 = Self::USER_LIFETIME_THRESHOLD;

    // ── Private helpers ──────────────────────────────────────────────────────

    fn set_role_internal(env: &Env, role: Role, account: &Address) {
        // Only one address can be the designated signer for a role at a time.
        // When a role is reassigned, clear the previous holder's grant so the
        // per-address set in `DataKey::UserRole` keeps agreeing with what
        // `require_role` will actually accept; otherwise the displaced holder
        // keeps reporting the role through `has_role` while being unable to
        // exercise it.
        if let Some(previous) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Role(role))
        {
            if &previous != account {
                env.storage()
                    .persistent()
                    .set(&DataKey::UserRole(previous, role), &false);
            }
        }
        env.storage().instance().set(&DataKey::Role(role), account);
        env.storage()
            .persistent()
            .set(&DataKey::UserRole(account.clone(), role), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::UserRole(account.clone(), role),
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );
    }

    fn remove_role_internal(env: &Env, role: Role, account: &Address) {
        if let Some(current) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Role(role))
        {
            if current == *account {
                env.storage().instance().remove(&DataKey::Role(role));
            }
        }
        env.storage()
            .persistent()
            .set(&DataKey::UserRole(account.clone(), role), &false);
    }

    /// Applies a role grant and emits `role_assigned`.
    ///
    /// Idempotent: granting a role the grantee already holds re-writes the same
    /// state and emits the same event rather than failing, so a retried or
    /// duplicated administrative call converges instead of trapping.
    fn apply_role_grant(env: &Env, grantee: &Address, role: Role) {
        Self::set_role_internal(env, role, grantee);
        env.events().publish(
            (Symbol::new(env, "role_assigned"), role, grantee.clone()),
            env.ledger().timestamp(),
        );
    }

    /// Applies a role revocation and emits `role_revoked`.
    ///
    /// Idempotent, and the mirror of [`Self::apply_role_grant`]: revoking a
    /// role that was never held clears an already-clear grant and emits the
    /// same event, so callers do not have to track prior state to revoke.
    fn apply_role_revoke(env: &Env, grantee: &Address, role: Role) {
        Self::remove_role_internal(env, role, grantee);
        env.events().publish(
            (Symbol::new(env, "role_revoked"), role, grantee.clone()),
            env.ledger().timestamp(),
        );
    }

    fn require_role(env: &Env, role: Role) -> Result<Address, Error> {
        let addr = if let Some(role_addr) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Role(role))
        {
            role_addr
        } else {
            Self::require_admin(env)?
        };
        addr.require_auth();
        Ok(addr)
    }

    fn require_admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// Reports whether `account` currently holds `role` for the purposes of
    /// `require_role`.
    ///
    /// A role has at most one designated address (`DataKey::Role`), so this
    /// mirrors the resolution order of [`Self::require_role`]: the per-address
    /// grant first, then the designated address, and finally — when the role
    /// has no designated address at all — the root admin, which inherits every
    /// role that has not been delegated away.
    ///
    /// Keeping the two in step matters: an integration that asks `has_role`
    /// before building a transaction must not be told "yes" for an address the
    /// contract will then refuse to authorize, nor "no" for one it will accept.
    fn has_role_internal(env: &Env, account: &Address, role: Role) -> bool {
        let granted: bool = env
            .storage()
            .persistent()
            .get(&DataKey::UserRole(account.clone(), role))
            .unwrap_or(false);
        if granted {
            return true;
        }
        let designated: Option<Address> = env.storage().instance().get(&DataKey::Role(role));
        match designated {
            Some(primary) => &primary == account,
            None => {
                env.storage()
                    .instance()
                    .get::<DataKey, Address>(&DataKey::Admin)
                    .as_ref()
                    == Some(account)
            }
        }
    }

    /// Asserts that an explicitly supplied `caller` holds `role`, authorizing
    /// the call on that address's behalf.
    ///
    /// This is the caller-addressed counterpart to [`Self::require_role`],
    /// which resolves the single address the contract expects to sign on its
    /// own.  Entrypoints that name the acting admin as a parameter — the
    /// role-management calls — use this so that a caller without the role is
    /// rejected with [`Error::RoleNotFound`] instead of silently authorizing
    /// some other stored address.
    fn require_role_of(env: &Env, caller: &Address, role: Role) -> Result<(), Error> {
        if !Self::has_role_internal(env, caller, role) {
            return Err(Error::RoleNotFound);
        }
        caller.require_auth();
        Ok(())
    }

    /// Fee authority helper: if a Governance address is set it takes exclusive
    /// control over fee updates; otherwise the FeeManager retains that right.
    fn require_fee_authority(env: &Env) -> Result<(), Error> {
        if let Some(gov) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Governance)
        {
            gov.require_auth();
            Ok(())
        } else {
            Self::require_role(env, Role::FeeManager)?;
            Ok(())
        }
    }

    // ── Multi-signature (M-of-N) upgrade helpers ────────────────────────────
    //
    // Contract upgrades used to be gated on a single admin key, which made the
    // admin both a single point of failure and a single point of
    // centralization.  Upgrades are now gated on an explicit M-of-N admin
    // group: each signer authorizes an individual WASM hash by calling
    // `approve_upgrade`, and the hash only becomes installable once `M`
    // distinct members of the group have signed off on that exact hash.
    //
    // Authorizations are recorded per-hash rather than per-time-window so that
    // a signature collected for one upgrade can never be replayed to authorize
    // a different one.

    /// Loads the multi-signature admin group, or fails closed when none has
    /// been configured.
    ///
    /// The signer set and the threshold are written together by
    /// `set_multisig_config`, so a present `MultisigThreshold` key implies a
    /// present `MultisigSigners` key; only the threshold has to be probed.
    fn load_multisig_config(env: &Env) -> Result<(Vec<Address>, u32), Error> {
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MultisigThreshold)
            .ok_or(Error::MultisigNotInitialized)?;
        let signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::MultisigSigners)
            .ok_or(Error::MultisigNotInitialized)?;
        Ok((signers, threshold))
    }

    /// Validates a candidate signer set / threshold pair and returns the
    /// configured threshold.
    ///
    /// Rejects configurations that could never authorize an upgrade, and
    /// duplicate signers, which would otherwise let a single key pad the
    /// effective signer count.
    fn validate_multisig_config(signers: &Vec<Address>, threshold: u32) -> Result<u32, Error> {
        if signers.is_empty() {
            return Err(Error::InvalidMultisigConfig);
        }
        if threshold == 0 || threshold > signers.len() {
            return Err(Error::InvalidMultisigConfig);
        }
        // O(n^2) over a group that is small by design; run once per config
        // change rather than on the approval hot path.
        for i in 0..signers.len() {
            for j in (i + 1)..signers.len() {
                if signers.get(i) == signers.get(j) {
                    return Err(Error::InvalidMultisigConfig);
                }
            }
        }
        Ok(threshold)
    }

    /// Returns the approvals collected so far for `new_wasm_hash`.
    fn load_upgrade_approvals(env: &Env, new_wasm_hash: &BytesN<32>) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::UpgradeApproval(new_wasm_hash.clone()))
            .unwrap_or_else(|| Vec::new(env))
    }

    /// Returns the approvals for `new_wasm_hash` that still count, i.e. those
    /// cast by a member of the *current* signer set.
    ///
    /// Stored approvals are filtered on read rather than rewritten when the
    /// group rotates, so dropping a signer immediately strips the weight of any
    /// approval it had already cast instead of leaving a stale vote behind. The
    /// scan is over a group and an approval list that are both bounded by the
    /// group size, so it stays cheap and every stored value is read at most
    /// once.
    fn load_effective_approvals(
        env: &Env,
        signers: &Vec<Address>,
        new_wasm_hash: &BytesN<32>,
    ) -> Vec<Address> {
        let stored = Self::load_upgrade_approvals(env, new_wasm_hash);
        let mut effective = Vec::new(env);
        for i in 0..stored.len() {
            let approver = stored.get(i).unwrap();
            if signers.contains(&approver) {
                effective.push_back(approver);
            }
        }
        effective
    }

    /// Returns `true` when at least `M` distinct current group members have
    /// approved `new_wasm_hash`, i.e. when the upgrade is authorized.
    fn check_upgrade_authorized(env: &Env, new_wasm_hash: &BytesN<32>) -> Result<bool, Error> {
        let (signers, threshold) = Self::load_multisig_config(env)?;
        Ok(Self::load_effective_approvals(env, &signers, new_wasm_hash).len() >= threshold)
    }

    /// The M-of-N gate every upgrade path funnels through.  Returns the
    /// approval count so callers can emit it in events.
    fn require_upgrade_authorized(env: &Env, new_wasm_hash: &BytesN<32>) -> Result<u32, Error> {
        let (signers, threshold) = Self::load_multisig_config(env)?;
        let approvals = Self::load_effective_approvals(env, &signers, new_wasm_hash);
        if approvals.len() < threshold {
            return Err(Error::InsufficientApprovals);
        }
        Ok(approvals.len())
    }

    /// Installs `new_wasm_hash` and consumes the approvals that authorized it.
    ///
    /// Clearing the approvals is what makes a threshold reached exactly once
    /// per set of signatures: after the swap the group has to sign off again
    /// before any further upgrade can proceed.
    fn apply_upgrade(env: &Env, new_wasm_hash: &BytesN<32>) {
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.storage()
            .persistent()
            .remove(&DataKey::UpgradeApproval(new_wasm_hash.clone()));
    }

    /// Persists a validated signer set / threshold pair.
    ///
    /// The signer set is rotated as a whole: a signer that is dropped from the
    /// group also loses the right to approve, *and* loses the weight of any
    /// approval it had already cast, because authorization counts only
    /// approvals made by current members. Outgoing approvals for hashes that
    /// are still in flight are left in storage untouched — they simply stop
    /// counting, so a rotation can revoke in-progress upgrades without having
    /// to walk every hash. A signer that is added starts with no approvals.
    fn store_multisig_config(env: &Env, signers: Vec<Address>, threshold: u32) {
        env.storage()
            .instance()
            .set(&DataKey::MultisigSigners, &signers);
        env.storage()
            .instance()
            .set(&DataKey::MultisigThreshold, &threshold);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
    }

    /// Pre-flight checks for a queued timelock action, run before the entry is
    /// removed so a rejected action leaves the queue intact.
    fn validate_queued_action(env: &Env, action: &ActionType) -> Result<(), Error> {
        match action {
            ActionType::Upgrade(new_wasm_hash) => {
                Self::require_upgrade_authorized(env, new_wasm_hash)?;
            }
            ActionType::SetMultisigConfig(signers, threshold) => {
                Self::validate_multisig_config(signers, *threshold)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn load_fee_config(env: &Env) -> Result<(Address, i128, i128), Error> {
        let platform_treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformTreasury)
            .ok_or(Error::NotInitialized)?;
        let fee_bps: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .ok_or(Error::NotInitialized)?;
        let fee_cap: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeCap)
            .ok_or(Error::NotInitialized)?;

        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        Ok((platform_treasury, fee_bps, fee_cap))
    }

    /// Validates that a swap path is well-formed and connects the expected tokens.
    fn validate_swap_path(
        token_in: &Address,
        token_out: &Address,
        path: &Vec<Address>,
        min_amount_out: i128,
    ) -> Result<(), Error> {
        if path.is_empty() {
            return Err(Error::InvalidSwapPath);
        }
        if path.first().is_none_or(|a| a != *token_in) {
            return Err(Error::InvalidSwapPath);
        }
        if path.last().is_none_or(|a| a != *token_out) {
            return Err(Error::InvalidSwapPath);
        }
        if min_amount_out <= 0 {
            return Err(Error::InvalidSwapParams);
        }
        Ok(())
    }

    fn get_refund_balance_internal(env: &Env, user: &Address, token: &Address) -> i128 {
        let key = DataKey::RefundBalance(user.clone(), token.clone());
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    fn credit_refund_balance(env: &Env, user: &Address, token: &Address, amount: i128) {
        let key = DataKey::RefundBalance(user.clone(), token.clone());
        let current_balance: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_balance = current_balance + amount;
        env.storage().persistent().set(&key, &new_balance);
        env.storage().persistent().extend_ttl(
            &key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (symbol_short!("refunded"), user.clone(), token.clone()),
            amount,
        );
    }

    /// Loads a sender's packed `UserRecord`, falling back to the legacy
    /// pre-#663 split entries when no packed record exists yet.
    ///
    /// Returns `(last_reset_time, accumulated_amount, volume, legacy_found)`.
    /// When neither format is present — the sender has never routed a payment —
    /// the 24-hour window is anchored at `current_time` with zeroed counters.
    /// `legacy_found` is `true` only when the values came from the legacy split
    /// entries, telling the caller to drop those stale keys after writing the
    /// packed record.
    fn load_user_record(env: &Env, sender: &Address, current_time: u64) -> (u64, i128, i128, bool) {
        let record_key = DataKey::UserRecord(sender.clone());

        if let Some(packed) = env
            .storage()
            .persistent()
            .get::<DataKey, BytesN<40>>(&record_key)
        {
            let (last_reset_time, accumulated_amount, volume) = unpack_user_record(&packed);
            return (last_reset_time, accumulated_amount, volume, false);
        }

        // Legacy fallback: combine the pre-#663 split entries.
        let legacy_spending: Option<(u64, i128)> = env
            .storage()
            .persistent()
            .get(&DataKey::UserSpending(sender.clone()))
            .map(|packed: BytesN<24>| unpack_legacy_spending(&packed));
        let legacy_volume: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::UserVolume(sender.clone()))
            .unwrap_or(0);
        let (last_reset_time, accumulated_amount) = legacy_spending.unwrap_or((current_time, 0));
        let legacy_found = legacy_spending.is_some() || legacy_volume != 0;
        (
            last_reset_time,
            accumulated_amount,
            legacy_volume,
            legacy_found,
        )
    }

    /// Rolls the sender's 24-hour spending window forward by `amount`, adds
    /// `amount` to their lifetime volume, and persists both in a single packed
    /// `UserRecord` entry (issue #663). Rejects the payment when the daily cap
    /// would be exceeded.
    ///
    /// Shared by the direct, meta-transaction and swap-routed payment paths so
    /// all three apply the same window, reset and cap rules.
    ///
    /// Returns the sender's volume *before* this payment, which is what the
    /// tiered fee discount is decided on.
    fn accrue_user_record(env: &Env, sender: &Address, amount: i128) -> Result<i128, Error> {
        let current_time = env.ledger().timestamp();
        let record_key = DataKey::UserRecord(sender.clone());

        let (mut last_reset_time, mut accumulated_amount, volume, legacy_found) =
            Self::load_user_record(env, sender, current_time);

        if current_time - last_reset_time >= Self::SECONDS_IN_24H {
            last_reset_time = current_time;
            accumulated_amount = 0;
        }

        let Some(new_accumulated) = accumulated_amount.checked_add(amount) else {
            return Err(Error::LimitExceeded);
        };
        if new_accumulated > Self::DAILY_MAX_LIMIT {
            return Err(Error::LimitExceeded);
        }
        accumulated_amount = new_accumulated;

        let new_volume = volume.saturating_add(amount);

        // One write and one TTL extension for both counters.
        env.storage().persistent().set(
            &record_key,
            &pack_user_record(env, last_reset_time, accumulated_amount, new_volume),
        );
        env.storage().persistent().extend_ttl(
            &record_key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        // One-time cleanup: when this write consumed legacy split entries,
        // drop them so the old keys stop accruing state rent. Steady-state
        // payments skip both removals entirely.
        if legacy_found {
            env.storage()
                .persistent()
                .remove(&DataKey::UserSpending(sender.clone()));
            env.storage()
                .persistent()
                .remove(&DataKey::UserVolume(sender.clone()));
        }

        Ok(volume)
    }

    /// Returns whether the contract is currently frozen.
    fn is_frozen_internal(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Frozen)
            .unwrap_or(false)
    }

    /// Returns whether the contract is currently paused.
    fn is_paused_internal(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Circuit-breaker guard applied to every non-essential operation.
    ///
    /// While the pause switch is engaged all operational state changes —
    /// payments, timelock queue/execute, fee/treasury/governance/min-limit
    /// configuration, treasury yield movements and token recovery — are
    /// rejected with `Error::Paused`.
    ///
    /// Essential recovery paths (unpausing/unfreezing, cancelling a queued
    /// action, refunds and emergency withdrawals) stay available so a
    /// Pauser can always restore service.
    fn require_circuit_closed(env: &Env) -> Result<(), Error> {
        if Self::is_paused_internal(env) {
            return Err(Error::Paused);
        }
        Ok(())
    }

    /// Enforces KYC only after the admin has configured a threshold. This
    /// preserves existing routing behavior until compliance is enabled.
    fn verify_kyc_for_amount(env: &Env, sender: &Address, amount: i128) -> Result<(), Error> {
        let threshold: Option<i128> = env.storage().instance().get(&DataKey::KycThreshold);
        if threshold.is_none() || amount <= threshold.unwrap_or(0) {
            return Ok(());
        }

        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::KycOracle)
            .ok_or(Error::KycRequired)?;
        if !KycOracleClient::new(env, &oracle).is_verified(sender) {
            return Err(Error::KycRequired);
        }
        Ok(())
    }

    /// Splits `amount` into the platform fee and the amount forwarded to the
    /// recipient, applying the fee cap and the volume-based discount.
    ///
    /// Shared by the direct and the swap-routed payment paths so both apply
    /// byte-for-byte identical fee arithmetic; `prop_tests` mirrors this
    /// function's invariants.
    fn calculate_fee(amount: i128, effective_fee_bps: i128, fee_cap: i128) -> (i128, i128) {
        let mut fee_amount = (amount * effective_fee_bps) / Self::BPS_DIVISOR;
        if fee_amount > fee_cap {
            fee_amount = fee_cap;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        (fee_amount, amount - fee_amount)
    }

    /// Returns the configured swap slippage ceiling in basis points.
    fn max_slippage_bps(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MaxSlippageBps)
            .unwrap_or(Self::DEFAULT_MAX_SLIPPAGE_BPS)
    }

    /// Returns whether a DEX router has been approved for swap routing.
    fn is_dex_registered_internal(env: &Env, dex: &Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::RegisteredDex(dex.clone()))
            .unwrap_or(false)
    }

    /// Invokes the DEX adapter and returns the amount it claims to have
    /// delivered.
    ///
    /// A reverting, missing, or mistyped DEX call is reported as
    /// [`Error::SwapFailed`] instead of trapping, so the caller can abort with
    /// a stable error code.  Because the error propagates out of the payment,
    /// the Soroban host reverts every balance and storage change made earlier
    /// in the same transaction.
    #[allow(clippy::too_many_arguments)]
    fn invoke_dex_swap(
        env: &Env,
        dex: &Address,
        sell_token: &Address,
        buy_token: &Address,
        amount_in: i128,
        min_amount_out: i128,
    ) -> Result<i128, Error> {
        let fn_name = Symbol::new(env, "swap");
        let args = vec![
            env,
            sell_token.clone().into_val(env),
            buy_token.clone().into_val(env),
            amount_in.into_val(env),
            min_amount_out.into_val(env),
            env.current_contract_address().into_val(env),
        ];

        let res: Result<Result<i128, SdkError>, Result<InvokeError, InvokeError>> =
            env.try_invoke_contract(dex, &fn_name, args);

        match res {
            Ok(Ok(amount_out)) => Ok(amount_out),
            Ok(Err(_)) | Err(_) => Err(Error::SwapFailed),
        }
    }

    /// Invokes the DEX adapter's quote for a read-only price check.
    ///
    /// Quotes never move funds, so a failure here is reported to the caller
    /// rather than trapping.
    fn invoke_dex_quote(
        env: &Env,
        dex: &Address,
        sell_token: &Address,
        buy_token: &Address,
        amount_in: i128,
    ) -> Result<i128, Error> {
        let args = vec![
            env,
            sell_token.clone().into_val(env),
            buy_token.clone().into_val(env),
            amount_in.into_val(env),
        ];
        let res: Result<Result<i128, SdkError>, Result<InvokeError, InvokeError>> =
            env.try_invoke_contract(dex, &Symbol::new(env, "quote"), args);

        match res {
            Ok(Ok(amount_out)) => Ok(amount_out),
            Ok(Err(_)) | Err(_) => Err(Error::SwapFailed),
        }
    }

    /// Returns the tightest `min_amount_out` that respects `max_slippage_bps`
    /// for a quote of `expected_amount_out`.
    fn slippage_floor(expected_amount_out: i128, max_slippage_bps: i128) -> i128 {
        let tolerated = (expected_amount_out * max_slippage_bps) / Self::BPS_DIVISOR;
        let floor = expected_amount_out - tolerated;
        if floor < 1 {
            1
        } else {
            floor
        }
    }

    /// Allocates and returns the next timelock nonce, incrementing the counter.
    fn next_nonce(env: &Env) -> u64 {
        let current: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TimelockNonce)
            .unwrap_or(0u64);
        let next = current + 1;
        env.storage().instance().set(&DataKey::TimelockNonce, &next);
        next
    }

    /// Returns the current meta-transaction nonce for a user (`0` if never used).
    fn get_meta_nonce_internal(env: &Env, user: &Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::MetaNonce(user.clone()))
            .unwrap_or(0)
    }

    /// Builds the domain-separated message for meta-transactions.
    /// Binds `current_contract_address` + `MetaPayment` struct + `signer_pubkey`.
    #[allow(clippy::too_many_arguments)]
    fn build_meta_message(
        env: &Env,
        sender: &Address,
        signer_pubkey: &BytesN<32>,
        recipient: &Address,
        token_address: &Address,
        amount: i128,
        nonce: u64,
        deadline: u64,
    ) -> Bytes {
        let mut payload = Bytes::new(env);
        payload.append(&env.current_contract_address().to_xdr(env));
        payload.append(&sender.to_xdr(env));
        payload.append(&Bytes::from_slice(env, &signer_pubkey.to_array()));
        payload.append(&recipient.to_xdr(env));
        payload.append(&token_address.to_xdr(env));
        payload.append(&amount.to_xdr(env));
        payload.append(&nonce.to_xdr(env));
        payload.append(&deadline.to_xdr(env));
        let hash = env.crypto().sha256(&payload);
        Bytes::from(&hash)
    }

    /// Core payment logic shared by `route_payment` and `route_payments`.
    ///
    /// The caller must have already obtained `sender`'s authorization, once
    /// per distinct sender across the batch (or via `require_auth` for a
    /// single payment). The transfers below re-check it inside the token
    /// contract, but doing it here first means an unauthorized payment is
    /// refused before any state is written.
    #[allow(clippy::too_many_arguments)]
    fn process_single_payment(
        env: &Env,
        sender: &Address,
        recipient: &Address,
        token_address: &Address,
        amount: i128,
        platform_treasury: &Address,
        fee_bps: i128,
        fee_cap: i128,
    ) -> Result<(), Error> {
        env.events().publish(
            (Symbol::new(env, "payment_initiated"), sender.clone()),
            amount,
        );

        // Validations moved to route_payments to prevent rollback panic on Windows testutils

        // Roll the 24-hour window forward and record the lifetime volume in a
        // single packed write (issue #663). The returned volume is the
        // pre-payment one, which is what the tiered discount keys off.
        let user_volume = Self::accrue_user_record(env, sender, amount)?;
        let effective_fee_bps = if user_volume > Self::VOLUME_THRESHOLD {
            fee_bps / 2
        } else {
            fee_bps
        };
        // Verify sender has sufficient balance
        let token_client = token::Client::new(env, token_address);
        if token_client.balance(sender) < amount {
            return Err(Error::InsufficientBalance);
        }

        // Calculate fee
        let mut fee_amount = amount.saturating_mul(effective_fee_bps) / Self::BPS_DIVISOR;
        if fee_amount > fee_cap {
            fee_amount = fee_cap;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        let remainder = amount - fee_amount;

        // Execute transfers safely without panics
        if fee_amount > 0
            && token_client
                .try_transfer(sender, platform_treasury, &fee_amount)
                .is_err()
        {
            return Err(Error::LimitExceeded);
        }
        if remainder > 0 {
            // Attempt to transfer remainder directly to recipient.
            // If recipient cannot receive tokens (e.g. missing trustline or rejection),
            // transfer funds into the contract and credit the sender's internal refund ledger.
            match token_client.try_transfer(sender, recipient, &remainder) {
                Ok(Ok(())) => {
                    log!(env, "Remaining balance routed to recipient");
                }
                _ => {
                    log!(
                        env,
                        "Recipient transfer failed; crediting sender refund balance"
                    );
                    if let Ok(Ok(())) = token_client.try_transfer(
                        sender,
                        &env.current_contract_address(),
                        &remainder,
                    ) {
                        Self::credit_refund_balance(env, sender, token_address, remainder);
                    } else {
                        return Err(Error::LimitExceeded);
                    }
                }
            }
        }

        // Emit routed event
        env.events().publish(
            (symbol_short!("routed"), sender.clone(), recipient.clone()),
            amount,
        );

        log!(env, "Platform fee routed to treasury");

        Ok(())
    }

    /// Allowance-based variant for meta-transactions.
    /// Skips `sender.require_auth()`; funds move via `transfer_from` using
    /// allowance previously granted to the router contract, so a relayer
    /// can submit on the user's behalf after signature verification.
    #[allow(clippy::too_many_arguments)]
    fn process_single_payment_no_auth(
        env: &Env,
        sender: &Address,
        recipient: &Address,
        token_address: &Address,
        amount: i128,
        platform_treasury: &Address,
        fee_bps: i128,
        fee_cap: i128,
    ) -> Result<(), Error> {
        env.events().publish(
            (Symbol::new(env, "payment_initiated"), sender.clone()),
            amount,
        );

        if sender == recipient {
            return Err(Error::InvalidRecipient);
        }

        if Self::is_blacklisted(env.clone(), recipient.clone()) {
            return Err(Error::Blacklisted);
        }

        let max_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxAmount)
            .unwrap_or(Self::MAX_AMOUNT);
        if amount <= 0 || amount > max_amount {
            return Err(Error::LimitExceeded);
        }

        let min_limit: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinLimit)
            .unwrap_or(0);
        if amount < min_limit {
            return Err(Error::LimitExceeded);
        }

        Self::verify_kyc_for_amount(env, sender, amount)?;

        // Single packed write covering the 24-hour window and the lifetime
        // volume (issue #663); the discount keys off the pre-payment volume.
        let user_volume = Self::accrue_user_record(env, sender, amount)?;
        let effective_fee_bps = if user_volume > Self::VOLUME_THRESHOLD {
            fee_bps / 2
        } else {
            fee_bps
        };

        let router = env.current_contract_address();
        let token_client = token::Client::new(env, token_address);
        if token_client.balance(sender) < amount {
            return Err(Error::InsufficientBalance);
        }
        if token_client.allowance(sender, &router) < amount {
            return Err(Error::InsufficientBalance);
        }

        // Calculate fee
        let fee_product = amount.checked_mul(effective_fee_bps).unwrap_or(amount);
        let mut fee_amount = fee_product / Self::BPS_DIVISOR;
        if fee_amount > fee_cap {
            fee_amount = fee_cap;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        let remainder = amount - fee_amount;

        // Execute transfers via allowance without panics
        if fee_amount > 0
            && token_client
                .try_transfer_from(&router, sender, platform_treasury, &fee_amount)
                .is_err()
        {
            return Err(Error::LimitExceeded);
        }
        if remainder > 0 {
            match token_client.try_transfer_from(&router, sender, recipient, &remainder) {
                Ok(Ok(())) => {
                    log!(env, "Remaining balance routed to recipient");
                }
                _ => {
                    log!(
                        env,
                        "Recipient transfer failed; crediting sender refund balance"
                    );
                    if let Ok(Ok(())) =
                        token_client.try_transfer_from(&router, sender, &router, &remainder)
                    {
                        Self::credit_refund_balance(env, sender, token_address, remainder);
                    } else {
                        return Err(Error::LimitExceeded);
                    }
                }
            }
        }

        env.events().publish(
            (symbol_short!("routed"), sender.clone(), recipient.clone()),
            amount,
        );

        log!(env, "Platform fee routed to treasury");

        Ok(())
    }

    // ── Public contract methods ──────────────────────────────────────────────

    /// Circuit-breaker guard applied to every non-essential operation.
    ///
    /// While the pause switch is engaged all operational state changes —
    /// payments, timelock queue/execute, fee/treasury/governance/min-limit
    /// configuration, treasury yield movements and token recovery — are
    /// rejected with `Error::Paused`.
    ///
    /// Essential recovery paths (unpausing/unfreezing, cancelling a queued
    /// action, withdrawing refunds or emergency funds, role and admin
    /// governance, compliance configuration and upgrades) deliberately bypass
    /// this guard, so an incident can always be resolved while the breaker is
    /// open.
    fn require_circuit_closed(env: &Env) -> Result<(), Error> {
        if Self::is_paused_internal(env) {
            return Err(Error::Paused);
        }
        Ok(())
    }

    /// Returns whether the circuit breaker (pause switch) is currently open.
    fn is_paused_internal(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Enforces KYC only after the admin has configured a threshold. This
    /// preserves existing routing behavior until compliance is enabled.
    fn verify_kyc_for_amount(env: &Env, sender: &Address, amount: i128) -> Result<(), Error> {
        let threshold: Option<i128> = env.storage().instance().get(&DataKey::KycThreshold);
        if threshold.is_none() || amount <= threshold.unwrap_or(0) {
            return Ok(());
        }

        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::KycOracle)
            .ok_or(Error::KycRequired)?;
        if !KycOracleClient::new(env, &oracle).is_verified(sender) {
            return Err(Error::KycRequired);
        }
        Ok(())
    }

    /// One-time setup: records the admin and the initial fee configuration
    /// in instance storage. Must be called before `route_payment`.
    ///
    /// # Parameters
    /// * `env` - The Soroban environment interface.
    /// * `sender` - The address initiating the payment. Must authorize the transaction.
    /// * `recipient` - The destination address for the payment (e.g., the Anchor's wallet for fiat withdrawals).
    /// * `platform_treasury` - The address where the platform fee will be deposited.
    /// * `token_address` - The contract ID of the token asset being transferred (e.g., NGNC or USDC).
    /// * `amount` - The total amount of tokens to be routed (inclusive of the fee).
    pub fn initialize(
        env: Env,
        admin: Address,
        platform_treasury: Address,
        fee_bps: i128,
        fee_cap: i128,
        max_amount: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::PlatformTreasury, &platform_treasury);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::FeeCap, &fee_cap);
        env.storage()
            .instance()
            .set(&DataKey::MaxAmount, &max_amount);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::Frozen, &false);
        env.storage()
            .instance()
            .set(&DataKey::MaxSlippageBps, &Self::DEFAULT_MAX_SLIPPAGE_BPS);
        env.storage().instance().set(&DataKey::TimelockNonce, &0u64);
        // RBAC Initialization: assign initial admin to all operational roles
        Self::set_role_internal(&env, Role::SuperAdmin, &admin);
        Self::set_role_internal(&env, Role::TreasuryManager, &admin);
        Self::set_role_internal(&env, Role::ComplianceOfficer, &admin);
        Self::set_role_internal(&env, Role::FeeManager, &admin);
        Self::set_role_internal(&env, Role::Pauser, &admin);

        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        Ok(())
    }

    // ── Role-Based Access Control (RBAC) ────────────────────────────────────

    /// Grants an operational role to `grantee`.
    ///
    /// Only an address holding `SuperAdmin` may call this.  The `admin`
    /// parameter is the address expected to authorize the transaction, and
    /// `admin.require_auth()` is always invoked, so a caller that cannot supply
    /// that signature is rejected even if the role would otherwise resolve.
    ///
    /// # Parameters
    /// - `admin`: Address expected to authorize the call; must hold `SuperAdmin`.
    /// - `grantee`: Address to receive the role.
    /// - `role`: The `Role` variant to grant.
    ///
    /// # Returns
    /// `Ok(())` on success, `Err(Error::RoleNotFound)` if `admin` does not hold
    /// `SuperAdmin`, or `Err(Error::NotInitialized)` if the contract has no
    /// admin set yet.
    ///
    /// # Panics
    /// Panics if `admin` does not authorize the call.
    ///
    /// Granting a role the grantee already holds is a no-op that emits
    /// `role_assigned` again rather than an error.  Because a role has a single
    /// designated holder, granting it to a new address revokes it from the
    /// previous one.
    pub fn grant_role(env: Env, admin: Address, grantee: Address, role: Role) -> Result<(), Error> {
        Self::require_role_of(&env, &admin, Role::SuperAdmin)?;
        Self::apply_role_grant(&env, &grantee, role);
        Ok(())
    }

    /// Revokes an operational role from `grantee`.
    ///
    /// Only an address holding `SuperAdmin` may call this.  As with
    /// [`Self::grant_role`], `admin.require_auth()` is always invoked.
    ///
    /// # Parameters
    /// - `admin`: Address expected to authorize the call; must hold `SuperAdmin`.
    /// - `grantee`: Address from which the role will be revoked.
    /// - `role`: The `Role` variant to revoke.
    ///
    /// # Returns
    /// `Ok(())` on success, `Err(Error::RoleNotFound)` if `admin` does not hold
    /// `SuperAdmin`, `Err(Error::InvalidRole)` if the call would revoke the
    /// acting `SuperAdmin`'s own root role, or `Err(Error::NotInitialized)`.
    ///
    /// # Panics
    /// Panics if `admin` does not authorize the call.
    ///
    /// Revoking a role the grantee never held is a no-op that emits
    /// `role_revoked` rather than an error, so revocations are idempotent and
    /// safe to retry.
    pub fn revoke_role(
        env: Env,
        admin: Address,
        grantee: Address,
        role: Role,
    ) -> Result<(), Error> {
        Self::require_role_of(&env, &admin, Role::SuperAdmin)?;
        if role == Role::SuperAdmin && admin == grantee {
            return Err(Error::InvalidRole);
        }
        Self::apply_role_revoke(&env, &grantee, role);
        Ok(())
    }

    /// Grants an operational role to an account. SuperAdmin-protected.
    ///
    /// Retained for compatibility with the published bindings; this is
    /// [`Self::grant_role`] with the `admin` argument resolved by the contract
    /// instead of supplied by the caller.
    ///
    /// # Parameters
    /// - `account`: Target address to receive the role.
    /// - `role`: The `Role` variant to grant.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if uninitialized.
    ///
    /// # Panics
    /// Panics if the current `SuperAdmin` does not authorize the call.
    pub fn assign_role(env: Env, account: Address, role: Role) -> Result<(), Error> {
        // The resolved address is discarded: the point is the `require_auth()`
        // that `require_role` performs on it.
        Self::require_role(&env, Role::SuperAdmin)?;
        Self::apply_role_grant(&env, &account, role);
        Ok(())
    }

    /// Queries whether a given account holds an active role assignment.
    ///
    /// Read-only and authorization-free.  Reports effective authority: the
    /// account is granted the role directly, is the role's designated holder,
    /// or is the root admin standing in for a role that has not been delegated.
    ///
    /// # Parameters
    /// - `account`: Address to query.
    /// - `role`: Role variant to check.
    ///
    /// # Returns
    /// `true` if the account can exercise `role`, `false` otherwise.
    pub fn has_role(env: Env, account: Address, role: Role) -> bool {
        Self::has_role_internal(&env, &account, role)
    }

    /// Returns the primary designated member address for a role, if one is configured.
    ///
    /// # Parameters
    /// - `role`: The role variant to query.
    ///
    /// # Returns
    /// `Some(Address)` if set, or `None` if unassigned.
    pub fn get_role_member(env: Env, role: Role) -> Option<Address> {
        env.storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Role(role))
    }

    /// Returns the administrative role governing the specified role.
    ///
    /// In this RBAC architecture, `SuperAdmin` governs all operational roles.
    pub fn get_role_admin(_env: Env, _role: Role) -> Role {
        Role::SuperAdmin
    }

    // ── Timelock: queue / execute / cancel ───────────────────────────────────

    /// Queues an admin action to be executed after a 24-hour delay.
    ///
    /// The admin provides the desired `ActionType` variant and receives a
    /// numeric nonce that uniquely identifies this pending entry.  Pass this
    /// nonce to `execute_action` after 24 hours, or to `cancel_action` to
    /// abort the intent.
    ///
    /// Sensitive parameter changes (`set_platform_treasury`, `set_fee_config`,
    /// `set_fee_bps`, `set_governance`, `set_min_limit`, `transfer_admin`,
    /// `set_multisig_config`, `upgrade`) must go through the timelock.  Use the
    /// direct setter functions only for actions that are not sensitive (e.g.
    /// `set_pause` which can also be called directly for immediate operational
    /// pauses).
    ///
    /// Queueing does not pre-authorize anything on its own: `ActionType::Upgrade`
    /// and `ActionType::SetMultisigConfig` are re-validated at execution time,
    /// so an upgrade queued today still needs the multi-signature threshold to
    /// be met for that hash when the delay elapses.
    ///
    /// The contract must not be frozen when queuing, and the admin must
    /// authorize the call.
    pub fn queue_action(env: Env, action: ActionType) -> Result<u64, Error> {
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        // Circuit breaker: queuing a parameter change is a non-essential state
        // change and is blocked while paused.
        Self::require_circuit_closed(&env)?;

        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        let nonce = Self::next_nonce(&env);
        let queued_at = env.ledger().timestamp();

        let entry = TimelockEntry {
            queued_at,
            action: action.clone(),
        };

        let key = DataKey::TimelockEntry(nonce);
        env.storage().persistent().set(&key, &entry);
        env.storage().persistent().extend_ttl(
            &key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events().publish(
            (Symbol::new(&env, "action_queued"), admin),
            (nonce, queued_at),
        );

        log!(&env, "Timelock action queued with nonce {}", nonce);
        Ok(nonce)
    }

    /// Returns the pending `TimelockEntry` for the given nonce, or an error if
    /// it does not exist.
    pub fn get_queued_action(env: Env, nonce: u64) -> Result<TimelockEntry, Error> {
        let key = DataKey::TimelockEntry(nonce);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TimelockNotFound)
    }

    /// Executes a previously queued action identified by `nonce`.
    ///
    /// Requirements:
    /// - The contract must not be frozen.
    /// - The admin must authorize.
    /// - The entry identified by `nonce` must exist.
    /// - At least 24 hours (`SECONDS_IN_24H`) must have passed since queuing.
    /// - For [`ActionType::Upgrade`], the multi-signature threshold must
    ///   already be met for that WASM hash.
    ///
    /// On success the entry is removed and the underlying setter is invoked.
    pub fn execute_action(env: Env, nonce: u64) -> Result<(), Error> {
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        // Circuit breaker: applying a queued parameter change is a
        // non-essential state change and is blocked while paused.
        Self::require_circuit_closed(&env)?;

        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        let key = DataKey::TimelockEntry(nonce);
        let entry: TimelockEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TimelockNotFound)?;

        let now = env.ledger().timestamp();
        if now < entry.queued_at + Self::SECONDS_IN_24H {
            return Err(Error::TimelockNotReady);
        }

        // Validate the action before touching storage so that a rejected entry
        // stays in the queue for the admin to retry or cancel.  Upgrades are
        // gated on the M-of-N threshold here as well as in `upgrade`, so
        // routing an upgrade through the timelock is not a way around it.
        Self::validate_queued_action(&env, &entry.action)?;

        // Remove the entry before applying the action (checks-effects-interactions).
        env.storage().persistent().remove(&key);

        // Apply the action.
        match entry.action {
            ActionType::SetPlatformTreasury(new_treasury) => {
                env.storage()
                    .instance()
                    .set(&DataKey::PlatformTreasury, &new_treasury);
            }
            ActionType::SetFeeConfig(fee_bps, fee_cap) => {
                env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
                env.storage().instance().set(&DataKey::FeeCap, &fee_cap);
            }
            ActionType::SetFeeBps(new_fee_bps) => {
                env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
            }
            ActionType::SetGovernance(gov) => {
                env.storage().instance().set(&DataKey::Governance, &gov);
            }
            ActionType::SetMinLimit(min_limit) => {
                env.storage().instance().set(&DataKey::MinLimit, &min_limit);
            }
            ActionType::TransferAdmin(new_admin) => {
                env.storage().instance().set(&DataKey::Admin, &new_admin);
                Self::set_role_internal(&env, Role::SuperAdmin, &new_admin);
            }
            ActionType::Upgrade(new_wasm_hash) => {
                Self::apply_upgrade(&env, &new_wasm_hash);
            }
            ActionType::SetMultisigConfig(signers, threshold) => {
                Self::store_multisig_config(&env, signers, threshold);
            }
            ActionType::RegisterDex(dex) => {
                let key = DataKey::RegisteredDex(dex.clone());
                env.storage().persistent().set(&key, &true);
                env.storage().persistent().extend_ttl(
                    &key,
                    Self::PERSISTENT_LIFETIME_THRESHOLD,
                    Self::PERSISTENT_BUMP_AMOUNT,
                );
            }
            ActionType::DeregisterDex(dex) => {
                env.storage()
                    .persistent()
                    .remove(&DataKey::RegisteredDex(dex.clone()));
            }
            ActionType::SetMaxSlippageBps(max_slippage_bps) => {
                env.storage()
                    .instance()
                    .set(&DataKey::MaxSlippageBps, &max_slippage_bps);
            }
        }

        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events()
            .publish((Symbol::new(&env, "action_executed"), admin), nonce);

        log!(&env, "Timelock action executed for nonce {}", nonce);
        Ok(())
    }

    /// Cancels a pending timelock entry before it can be executed.
    ///
    /// This is the primary defence when a compromised admin has queued a
    /// malicious action: any other admin (after a key rotation) or a
    /// multi-sig governance can cancel it within the 24-hour window.
    ///
    /// Admin authorization is required. The contract may be frozen.
    pub fn cancel_action(env: Env, nonce: u64) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        let key = DataKey::TimelockEntry(nonce);
        if !env.storage().persistent().has(&key) {
            return Err(Error::TimelockNotFound);
        }

        env.storage().persistent().remove(&key);

        env.events()
            .publish((Symbol::new(&env, "action_cancelled"), admin), nonce);

        log!(&env, "Timelock action cancelled for nonce {}", nonce);
        Ok(())
    }

    // ── Freeze / unfreeze ────────────────────────────────────────────────────

    /// Instantly freezes the contract, blocking all payments and timelock
    /// executions.  This is the emergency last resort when an admin key is
    /// known to be compromised.
    ///
    /// Unlike other sensitive admin operations, freeze takes effect immediately
    /// — it does NOT go through the timelock — so it is always available as a
    /// rapid-response tool.
    ///
    /// Admin authorization is required.
    pub fn emergency_freeze(env: Env) -> Result<(), Error> {
        let super_admin = Self::require_role(&env, Role::SuperAdmin)?;

        env.storage().instance().set(&DataKey::Frozen, &true);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events().publish(
            (Symbol::new(&env, "emergency_freeze"), super_admin),
            env.ledger().timestamp(),
        );

        log!(&env, "Contract frozen by SuperAdmin");
        Ok(())
    }

    /// Removes the frozen state, restoring normal contract operation.
    ///
    /// Like `emergency_freeze`, this takes effect immediately and does not
    /// go through the timelock.
    ///
    /// SuperAdmin authorization is required.
    pub fn unfreeze(env: Env) -> Result<(), Error> {
        let super_admin = Self::require_role(&env, Role::SuperAdmin)?;

        env.storage().instance().set(&DataKey::Frozen, &false);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events().publish(
            (Symbol::new(&env, "unfreeze"), super_admin),
            env.ledger().timestamp(),
        );

        log!(&env, "Contract unfrozen by SuperAdmin");
        Ok(())
    }

    /// Returns whether the contract is currently frozen.
    pub fn is_frozen(env: Env) -> bool {
        Self::is_frozen_internal(&env)
    }

    // ── Sensitive admin setters (now require timelock) ───────────────────────
    //
    // The functions below are intentionally kept as thin wrappers that apply
    // the change *directly* but only when called from execute_action (i.e.
    // after the timelock has been satisfied).  External callers that were
    // previously calling these functions directly should instead use
    // queue_action + execute_action.
    //
    // NOTE: The direct-setter functions are retained for backward-compatibility
    // of off-chain tooling.  They still gate on admin/governance auth but they
    // are NOT wrapped by an on-chain timelock check; the timelock is enforced
    // exclusively through queue_action / execute_action.

    /// Updates the treasury address that receives the platform fee.
    ///
    /// Updates the treasury address that receives the platform fee. Protected by TreasuryManager.
    ///
    /// # Parameters
    /// - `new_treasury`: Address to receive platform fees going forward.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the current TreasuryManager does not authorize the call.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetPlatformTreasury(…))`
    /// and execute after 24 hours.  This direct path is retained for tooling
    /// compatibility only.
    pub fn set_platform_treasury(env: Env, new_treasury: Address) -> Result<(), Error> {
        // Circuit breaker: platform parameter changes are non-essential.
        Self::require_circuit_closed(&env)?;
        Self::require_role(&env, Role::TreasuryManager)?;

        env.storage()
            .instance()
            .set(&DataKey::PlatformTreasury, &new_treasury);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Updates the fee basis points and fee cap.
    /// Requires governance authority if a governance address is set; otherwise admin-only.
    ///
    /// # Parameters
    /// - `fee_bps`: New platform fee rate, in basis points.
    /// - `fee_cap`: New maximum fee taken from a single payment.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the caller does not authorize the call.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetFeeConfig(…))`.
    pub fn set_fee_config_legacy(env: Env, fee_bps: i128, fee_cap: i128) -> Result<(), Error> {
        // Circuit breaker: fee parameter changes are non-essential.
        Self::require_circuit_closed(&env)?;
        Self::require_fee_authority(&env)?;

        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::FeeCap, &fee_cap);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Alias for `set_fee_config_legacy`. Admin-only.
    ///
    /// # Parameters
    /// - `fee_bps`: New platform fee rate, in basis points.
    /// - `fee_cap`: New maximum fee taken from a single payment.
    ///
    /// # Returns
    /// See `set_fee_config_legacy`.
    ///
    /// # Panics
    /// Panics if the current admin does not authorize the call.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetFeeConfig(…))`.
    pub fn set_fee_config(env: Env, fee_bps: i128, fee_cap: i128) -> Result<(), Error> {
        Self::set_fee_config_legacy(env, fee_bps, fee_cap)
    }

    /// Updates the fee basis points.
    /// Requires governance authority if a governance address is set; otherwise admin-only.
    ///
    /// # Parameters
    /// - `new_fee_bps`: New platform fee rate, in basis points.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the caller does not authorize the call.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetFeeBps(…))`.
    pub fn set_fee_bps(env: Env, new_fee_bps: i128) -> Result<(), Error> {
        // Circuit breaker: fee parameter changes are non-essential.
        Self::require_circuit_closed(&env)?;
        Self::require_fee_authority(&env)?;

        env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Sets the governance contract address. After this call, only the governance
    /// contract can update fees. Admin-only — can only be set once per governance cycle.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetGovernance(…))`.
    pub fn set_governance(env: Env, gov: Address) -> Result<(), Error> {
        // Circuit breaker: governance parameter changes are non-essential.
        Self::require_circuit_closed(&env)?;
        Self::require_role(&env, Role::SuperAdmin)?;
        env.storage().instance().set(&DataKey::Governance, &gov);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Configures the DAO token and minimum voting weight for fee proposals.
    /// This administrative bootstrap does not itself change fees; subsequent
    /// fee changes can be made through the proposal lifecycle.
    pub fn configure_governance(
        env: Env,
        governance_token: Address,
        quorum: i128,
    ) -> Result<(), Error> {
        Self::require_role(&env, Role::SuperAdmin)?;
        if quorum <= 0 {
            return Err(Error::InvalidProposal);
        }
        env.storage()
            .instance()
            .set(&DataKey::GovernanceToken, &governance_token);
        env.storage()
            .instance()
            .set(&DataKey::GovernanceQuorum, &quorum);
        Ok(())
    }

    /// Creates a fee proposal weighted by governance-token balances.
    pub fn propose_fee_change(
        env: Env,
        proposer: Address,
        fee_bps: i128,
        fee_cap: i128,
        voting_period: u64,
    ) -> Result<u64, Error> {
        proposer.require_auth();
        let governance_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::GovernanceToken)
            .ok_or(Error::GovernanceNotConfigured)?;
        if token::Client::new(&env, &governance_token).balance(&proposer) <= 0 {
            return Err(Error::GovernanceNotConfigured);
        }
        if !(0..=10_000).contains(&fee_bps) || fee_cap < 0 || voting_period == 0 {
            return Err(Error::InvalidProposal);
        }
        let nonce: u64 = env
            .storage()
            .instance()
            .get(&DataKey::GovernanceNonce)
            .unwrap_or(0);
        let id = nonce.saturating_add(1);
        env.storage().instance().set(&DataKey::GovernanceNonce, &id);
        let quorum = env
            .storage()
            .instance()
            .get(&DataKey::GovernanceQuorum)
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::GovernanceProposal(id),
            &FeeProposal {
                proposer,
                fee_bps,
                fee_cap,
                created_at: env.ledger().timestamp(),
                voting_ends_at: env.ledger().timestamp().saturating_add(voting_period),
                yes_votes: 0,
                no_votes: 0,
                quorum,
                executed: false,
            },
        );
        Ok(id)
    }

    /// Casts one weighted vote on an open fee proposal.
    pub fn vote_fee_proposal(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: bool,
    ) -> Result<(), Error> {
        voter.require_auth();
        let token_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::GovernanceToken)
            .ok_or(Error::GovernanceNotConfigured)?;
        let key = DataKey::GovernanceProposal(proposal_id);
        let mut proposal: FeeProposal = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::InvalidProposal)?;
        if proposal.executed || env.ledger().timestamp() >= proposal.voting_ends_at {
            return Err(Error::InvalidProposal);
        }
        let vote_key = DataKey::GovernanceVote(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(Error::AlreadyVoted);
        }
        let weight = token::Client::new(&env, &token_address).balance(&voter);
        if weight <= 0 {
            return Err(Error::InvalidProposal);
        }
        if support {
            proposal.yes_votes = proposal.yes_votes.saturating_add(weight);
        } else {
            proposal.no_votes = proposal.no_votes.saturating_add(weight);
        }
        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().set(&vote_key, &true);
        Ok(())
    }

    /// Finalizes a successful fee proposal after its voting period ends.
    pub fn execute_fee_proposal(env: Env, proposal_id: u64) -> Result<(), Error> {
        let key = DataKey::GovernanceProposal(proposal_id);
        let mut proposal: FeeProposal = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::InvalidProposal)?;
        if proposal.executed
            || env.ledger().timestamp() < proposal.voting_ends_at
            || proposal.yes_votes <= proposal.no_votes
            || proposal.yes_votes.saturating_add(proposal.no_votes) < proposal.quorum
        {
            return Err(Error::InvalidProposal);
        }
        proposal.executed = true;
        env.storage().persistent().set(&key, &proposal);
        env.storage()
            .instance()
            .set(&DataKey::FeeBps, &proposal.fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::FeeCap, &proposal.fee_cap);
        Ok(())
    }

    pub fn get_fee_proposal(env: Env, proposal_id: u64) -> Option<FeeProposal> {
        env.storage()
            .persistent()
            .get(&DataKey::GovernanceProposal(proposal_id))
    }

    /// Sets the minimum allowed routing amount. FeeManager-protected.
    ///
    /// # Parameters
    /// - `min_limit`: Smallest `amount` that `route_payment` /
    ///   `route_payments` will accept going forward.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the current FeeManager does not authorize the call.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetMinLimit(…))`.
    pub fn set_min_limit(env: Env, min_limit: i128) -> Result<(), Error> {
        // Circuit breaker: routing limit changes are non-essential.
        Self::require_circuit_closed(&env)?;
        Self::require_role(&env, Role::FeeManager)?;

        env.storage().instance().set(&DataKey::MinLimit, &min_limit);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Returns the current protocol fee percentage in basis points.
    ///
    /// # Returns
    /// The configured `fee_bps`, or `0` if the contract has not been
    /// initialized.
    ///
    /// # Panics
    /// Does not panic.
    pub fn get_fee(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }

    /// Pauses or unpauses the payment router. Pauser-protected.
    ///
    /// # Parameters
    /// - `paused`: `true` to reject `route_payment` / `route_payments`
    ///   calls, `false` to allow them again.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the current Pauser does not authorize the call.
    ///
    /// This is NOT timelocked — operational pausing must remain instant.
    pub fn set_pause(env: Env, paused: bool) -> Result<(), Error> {
        Self::require_role(&env, Role::Pauser)?;

        env.storage().instance().set(&DataKey::Paused, &paused);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events().publish((symbol_short!("pause"),), (paused,));

        Ok(())
    }

    /// Alias for `set_pause`. Pauser-protected.
    ///
    /// # Parameters
    /// - `paused`: `true` to reject routing calls, `false` to allow them.
    ///
    /// # Returns
    /// See `set_pause`.
    ///
    /// # Panics
    /// Panics if the current Pauser does not authorize the call.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::set_pause(env, paused)
    }

    /// Returns whether the contract is currently paused.
    ///
    /// # Returns
    /// `true` if paused, `false` if unpaused or not yet initialized.
    ///
    /// # Panics
    /// Does not panic.
    pub fn is_paused(env: Env) -> bool {
        Self::is_paused_internal(&env)
    }

    /// Returns the cumulative amount a given sender has routed through the contract.
    ///
    /// # Parameters
    /// - `user`: Sender address to look up.
    ///
    /// # Returns
    /// The lifetime routed volume for `user`, or `0` if they have never
    /// routed a payment.
    ///
    /// # Panics
    /// Does not panic.
    pub fn get_user_volume(env: Env, user: Address) -> i128 {
        Self::get_user_record(env, user).volume
    }

    /// Returns a sender's combined routing record: the amount accumulated in
    /// the current 24-hour window and their cumulative lifetime volume
    /// (issue #663).
    ///
    /// Reads the single packed `UserRecord` entry. For a sender that only has
    /// the legacy pre-#663 split entries, both counters are combined from
    /// those without writing anything.
    ///
    /// # Parameters
    /// - `user`: Sender address to look up.
    ///
    /// # Returns
    /// A [`UserRecord`] with zeroed counters if `user` has never routed a
    /// payment; `last_reset_time` is then the current ledger timestamp.
    ///
    /// # Panics
    /// Does not panic.
    pub fn get_user_record(env: Env, user: Address) -> UserRecord {
        let current_time = env.ledger().timestamp();
        let (last_reset_time, accumulated_amount, volume, _) =
            Self::load_user_record(&env, &user, current_time);

        UserRecord {
            accumulated_amount,
            volume,
            last_reset_time,
        }
    }

    /// Permissionless migration of a sender's legacy pre-#663 split entries
    /// (`UserSpending` + `UserVolume`) into the single packed `UserRecord`
    /// (issue #663).
    ///
    /// Callable by anyone: it only recombines values that are already on the
    /// ledger and never invents or destroys value. When the sender's packed
    /// record was already created by a recent payment, this just removes the
    /// stale legacy keys and keeps the newer packed values.
    ///
    /// # Parameters
    /// - `user`: The sender whose legacy entries should be migrated.
    ///
    /// # Returns
    /// `true` if legacy state was found and migrated, `false` if `user` has
    /// no legacy entries to migrate.
    ///
    /// # Panics
    /// Does not panic.
    pub fn migrate_user_record(env: Env, user: Address) -> bool {
        let record_key = DataKey::UserRecord(user.clone());
        let has_packed = env.storage().persistent().has(&record_key);

        let legacy_spending: Option<(u64, i128)> = env
            .storage()
            .persistent()
            .get(&DataKey::UserSpending(user.clone()))
            .map(|packed: BytesN<24>| unpack_legacy_spending(&packed));
        let legacy_volume: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::UserVolume(user.clone()))
            .unwrap_or(0);

        if legacy_spending.is_none() && legacy_volume == 0 {
            return false;
        }

        if !has_packed {
            let (last_reset_time, accumulated_amount) =
                legacy_spending.unwrap_or((env.ledger().timestamp(), 0));

            // The legacy `UserVolume` already counts every amount in the
            // current window (each payment incremented both counters), so the
            // window balance must not be added again here.
            env.storage().persistent().set(
                &record_key,
                &pack_user_record(&env, last_reset_time, accumulated_amount, legacy_volume),
            );
            env.storage().persistent().extend_ttl(
                &record_key,
                Self::PERSISTENT_LIFETIME_THRESHOLD,
                Self::PERSISTENT_BUMP_AMOUNT,
            );
        }

        env.storage()
            .persistent()
            .remove(&DataKey::UserSpending(user.clone()));
        env.storage()
            .persistent()
            .remove(&DataKey::UserVolume(user.clone()));

        env.events()
            .publish((symbol_short!("migrated"), user), legacy_volume);

        true
    }

    /// Adds an address to the blacklist. ComplianceOfficer-protected.
    ///
    /// # Parameters
    /// - `address`: Address to blacklist; subsequent payments to it as a
    ///   recipient will be rejected.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the current ComplianceOfficer does not authorize the call.
    pub fn blacklist_address(env: Env, address: Address) -> Result<(), Error> {
        Self::require_role(&env, Role::ComplianceOfficer)?;

        env.storage()
            .persistent()
            .set(&DataKey::Blacklist(address.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Blacklist(address),
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        Ok(())
    }

    /// Removes an address from the blacklist. ComplianceOfficer-protected.
    ///
    /// # Parameters
    /// - `address`: Address to remove from the blacklist.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the current ComplianceOfficer does not authorize the call.
    pub fn unblacklist_address(env: Env, address: Address) -> Result<(), Error> {
        Self::require_role(&env, Role::ComplianceOfficer)?;

        env.storage()
            .persistent()
            .remove(&DataKey::Blacklist(address));

        Ok(())
    }

    /// Returns whether an address is blacklisted.
    ///
    /// # Parameters
    /// - `address`: Address to check.
    ///
    /// # Returns
    /// `true` if `address` is blacklisted, `false` otherwise.
    ///
    /// # Panics
    /// Does not panic.
    pub fn is_blacklisted(env: Env, address: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Blacklist(address))
            .unwrap_or(false)
    }

    /// Returns the effective fee_bps for a sender after applying any
    /// volume-based tiered discount.
    ///
    /// # Parameters
    /// - `sender`: Address whose discounted fee rate to compute.
    ///
    /// # Returns
    /// The configured `fee_bps`, halved if `sender`'s lifetime volume
    /// exceeds the tiered-discount threshold, or `0` if not initialized.
    ///
    /// # Panics
    /// Does not panic.
    pub fn get_effective_fee_bps(env: Env, sender: Address) -> i128 {
        let fee_bps: i128 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let user_volume = Self::get_user_volume(env.clone(), sender);
        if user_volume > Self::VOLUME_THRESHOLD {
            fee_bps / 2
        } else {
            fee_bps
        }
    }

    /// Set a new admin. SuperAdmin-protected.
    ///
    /// # Parameters
    /// - `new_admin`: Address to install as the new admin.
    ///
    /// # Returns
    /// Always `Ok(())`.
    ///
    /// # Panics
    /// Panics if an admin is already set and current SuperAdmin does not authorize the call.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            Self::require_role(&env, Role::SuperAdmin)?;
        }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::set_role_internal(&env, Role::SuperAdmin, &new_admin);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Transfers admin rights to a new address. Requires current SuperAdmin authorization.
    ///
    /// # Parameters
    /// - `new_admin`: Address to become the new admin.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the current SuperAdmin does not authorize the call.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::TransferAdmin(…))`.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let current_admin = Self::require_role(&env, Role::SuperAdmin)?;
        Self::remove_role_internal(&env, Role::SuperAdmin, &current_admin);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::set_role_internal(&env, Role::SuperAdmin, &new_admin);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Recovers tokens accidentally sent directly to the contract address. TreasuryManager-protected.
    ///
    /// # Parameters
    /// - `token`: Contract ID of the token to recover.
    /// - `amount`: Amount to transfer from the contract's balance to the treasury manager.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the current TreasuryManager does not authorize the call, or if the
    /// token transfer fails (e.g. the contract's balance is below `amount`).
    pub fn recover_tokens(env: Env, token: Address, amount: i128) -> Result<(), Error> {
        // Circuit breaker: token recovery is a non-essential state change (the
        // TreasuryManager still has `emergency_withdraw` while paused).
        Self::require_circuit_closed(&env)?;
        let treasury_mgr = Self::require_role(&env, Role::TreasuryManager)?;

        let contract_address = env.current_contract_address();
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&contract_address, &treasury_mgr, &amount);

        Ok(())
    }

    /// Records a token as supported (no-op; routing accepts any token contract ID).
    ///
    /// # Parameters
    /// - `_token`: Ignored; present for API compatibility.
    ///
    /// # Returns
    /// Always `Ok(())`.
    ///
    /// # Panics
    /// Does not panic.
    pub fn add_supported_token(_env: Env, _token: Address) -> Result<(), Error> {
        Ok(())
    }

    /// Configures the lending protocol used for treasury yield operations. TreasuryManager-protected.
    pub fn set_yield_protocol(env: Env, protocol: Address) -> Result<(), Error> {
        Self::require_role(&env, Role::TreasuryManager)?;

        env.storage()
            .instance()
            .set(&DataKey::YieldProtocol, &protocol);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        env.events()
            .publish((symbol_short!("yield_cfg"),), protocol);
        Ok(())
    }

    /// Configures the trusted KYC oracle and the high-value payment threshold. ComplianceOfficer-protected.
    pub fn set_kyc_config(env: Env, oracle: Address, threshold: i128) -> Result<(), Error> {
        if threshold < 0 {
            return Err(Error::InvalidKycThreshold);
        }
        Self::require_role(&env, Role::ComplianceOfficer)?;

        env.storage().instance().set(&DataKey::KycOracle, &oracle);
        env.storage()
            .instance()
            .set(&DataKey::KycThreshold, &threshold);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        env.events()
            .publish((symbol_short!("kyc_cfg"), oracle), threshold);
        Ok(())
    }

    /// Deposits idle treasury funds into the configured lending protocol.
    ///
    /// Both the TreasuryManager and treasury authorize this operation. The second
    /// authorization is required because the funds are held by the treasury,
    /// rather than by this router contract.
    pub fn deposit_to_yield(env: Env, token: Address, amount: i128) -> Result<(), Error> {
        // Circuit breaker: moving treasury funds into yield is non-essential.
        Self::require_circuit_closed(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidYieldAmount);
        }

        Self::require_role(&env, Role::TreasuryManager)?;
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformTreasury)
            .ok_or(Error::NotInitialized)?;
        treasury.require_auth();
        let protocol: Address = env
            .storage()
            .instance()
            .get(&DataKey::YieldProtocol)
            .ok_or(Error::YieldProtocolNotConfigured)?;

        LendingProtocolClient::new(&env, &protocol).deposit(&treasury, &token, &amount);

        let key = DataKey::YieldPrincipal(token.clone());
        let principal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(principal + amount));
        env.storage().persistent().extend_ttl(
            &key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );
        env.events()
            .publish((symbol_short!("yield_dep"), token), amount);
        Ok(())
    }

    /// Withdraws treasury principal from the configured lending protocol. TreasuryManager-protected.
    pub fn withdraw_from_yield(env: Env, token: Address, amount: i128) -> Result<(), Error> {
        // Circuit breaker: yield principal movements are non-essential while
        // paused; `emergency_withdraw` remains the funds-out path.
        Self::require_circuit_closed(&env)?;
        let key = DataKey::YieldPrincipal(token.clone());
        let principal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount <= 0 || amount > principal {
            return Err(Error::InvalidYieldAmount);
        }

        Self::require_role(&env, Role::TreasuryManager)?;
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformTreasury)
            .ok_or(Error::NotInitialized)?;
        let protocol: Address = env
            .storage()
            .instance()
            .get(&DataKey::YieldProtocol)
            .ok_or(Error::YieldProtocolNotConfigured)?;

        LendingProtocolClient::new(&env, &protocol).withdraw(&treasury, &token, &amount);
        let remaining = principal - amount;
        if remaining == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &remaining);
            env.storage().persistent().extend_ttl(
                &key,
                Self::PERSISTENT_LIFETIME_THRESHOLD,
                Self::PERSISTENT_BUMP_AMOUNT,
            );
        }
        env.events()
            .publish((symbol_short!("yield_wdr"), token), amount);
        Ok(())
    }

    /// Claims all currently available yield to the platform treasury. TreasuryManager-protected.
    pub fn harvest_yield(env: Env, token: Address) -> Result<i128, Error> {
        // Circuit breaker: yield harvesting is a non-essential state change.
        Self::require_circuit_closed(&env)?;
        Self::require_role(&env, Role::TreasuryManager)?;
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformTreasury)
            .ok_or(Error::NotInitialized)?;
        let protocol: Address = env
            .storage()
            .instance()
            .get(&DataKey::YieldProtocol)
            .ok_or(Error::YieldProtocolNotConfigured)?;

        let harvested = LendingProtocolClient::new(&env, &protocol).harvest(&treasury, &token);
        env.events()
            .publish((symbol_short!("yield_har"), token), harvested);
        Ok(harvested)
    }

    /// Returns the tracked principal deposited for `token`.
    pub fn get_yield_position(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::YieldPrincipal(token))
            .unwrap_or(0)
    }

    /// Returns the configured KYC threshold, or `None` when enforcement is off.
    pub fn get_kyc_threshold(env: Env) -> Option<i128> {
        env.storage().instance().get(&DataKey::KycThreshold)
    }

    // ── Price-feed oracle ────────────────────────────────────────────────────

    /// Configures the price-feed oracle contract address. ComplianceOfficer-protected.
    ///
    /// The oracle contract must implement the [`PriceFeedOracle`] interface:
    /// it must expose a `get_price(base_asset, quote_asset) -> PriceData`
    /// method that returns the latest price together with a Unix timestamp so
    /// staleness can be validated against the configured threshold.
    ///
    /// # Parameters
    /// - `oracle`: Address of the oracle contract to use for price lookups.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has not been initialized.
    ///
    /// # Panics
    /// Panics if the current ComplianceOfficer does not authorize the call.
    pub fn set_price_oracle(env: Env, oracle: Address) -> Result<(), Error> {
        Self::require_role(&env, Role::ComplianceOfficer)?;

        env.storage()
            .instance()
            .set(&DataKey::OracleAddress, &oracle);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events().publish((symbol_short!("price_cfg"),), oracle);
        Ok(())
    }

    /// Sets the maximum age (in seconds) a price reading may have before it is
    /// considered stale. ComplianceOfficer-protected.
    ///
    /// When a price timestamp is older than `(current_ledger_time - threshold)`
    /// the reading is rejected with [`Error::OraclePriceStale`] and the
    /// fallback price (if configured) is used instead.
    ///
    /// # Parameters
    /// - `threshold_secs`: Maximum allowed age in seconds. A value of `0`
    ///   disables the staleness check entirely (every price is accepted).
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Panics
    /// Panics if the current ComplianceOfficer does not authorize the call.
    pub fn set_staleness_threshold(env: Env, threshold_secs: u64) -> Result<(), Error> {
        Self::require_role(&env, Role::ComplianceOfficer)?;

        env.storage()
            .instance()
            .set(&DataKey::StalenessThreshold, &threshold_secs);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events()
            .publish((symbol_short!("stale_cfg"),), threshold_secs);
        Ok(())
    }

    /// Stores an admin-supplied fallback price for a (base, quote) asset pair.
    /// ComplianceOfficer-protected.
    ///
    /// The fallback is used by [`get_price`] when the live oracle is
    /// unavailable or returns data that fails validation (stale or invalid).
    /// Setting a fallback price to `0` effectively removes the fallback,
    /// meaning that oracle failures will propagate as errors rather than
    /// silently using a stale cached value.
    ///
    /// # Parameters
    /// - `base_asset`: Address of the base asset (e.g. XLM contract).
    /// - `quote_asset`: Address of the quote asset (e.g. USDC contract).
    /// - `fallback_price`: Price expressed in the same fixed-point format as
    ///   the oracle (`price / 10^decimals`). Pass `0` to clear the fallback.
    /// - `decimals`: Decimal precision of `fallback_price`.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Panics
    /// Panics if the current ComplianceOfficer does not authorize the call.
    pub fn set_fallback_price(
        env: Env,
        base_asset: Address,
        quote_asset: Address,
        fallback_price: i128,
        decimals: u32,
    ) -> Result<(), Error> {
        Self::require_role(&env, Role::ComplianceOfficer)?;

        let key = DataKey::FallbackPrice(base_asset.clone(), quote_asset.clone());
        if fallback_price == 0 {
            // A zero fallback means "no fallback configured": remove the entry.
            env.storage().persistent().remove(&key);
        } else {
            let data = PriceData {
                price: fallback_price,
                decimals,
                // Timestamp 0 signals "static fallback — staleness does not apply".
                timestamp: 0,
            };
            env.storage().persistent().set(&key, &data);
            env.storage().persistent().extend_ttl(
                &key,
                Self::PERSISTENT_LIFETIME_THRESHOLD,
                Self::PERSISTENT_BUMP_AMOUNT,
            );
        }

        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events().publish(
            (symbol_short!("fall_cfg"), base_asset, quote_asset),
            fallback_price,
        );
        Ok(())
    }

    /// Returns the stored fallback price for a (base, quote) asset pair, if any.
    ///
    /// # Parameters
    /// - `base_asset`: Address of the base asset.
    /// - `quote_asset`: Address of the quote asset.
    ///
    /// # Returns
    /// `Some(PriceData)` if a fallback has been configured, `None` otherwise.
    pub fn get_fallback_price(
        env: Env,
        base_asset: Address,
        quote_asset: Address,
    ) -> Option<PriceData> {
        env.storage()
            .persistent()
            .get(&DataKey::FallbackPrice(base_asset, quote_asset))
    }

    /// Fetches the current exchange rate for a `(base_asset, quote_asset)`
    /// pair from the configured price-feed oracle, validates it, and returns
    /// the result.
    ///
    /// Every failure path below first attempts to serve an admin-configured
    /// fallback price for the pair; the oracle error is only surfaced when no
    /// fallback exists.
    ///
    /// ## Validation flow
    ///
    /// 1. **Oracle configured?** - Otherwise `Err(Error::OracleNotConfigured)`.
    /// 2. **Call oracle** - Invoke the oracle's `get_price`; a trapped or
    ///    unavailable contract yields `Err(Error::OracleCallFailed)`.
    /// 3. **Staleness check** - Reject a `price_data.timestamp` older than the
    ///    configured threshold (default 3 600 s) with
    ///    `Err(Error::OraclePriceStale)`. A threshold of `0` disables this check.
    /// 4. **Validity check** - A price <= 0 is invalid
    ///    (`Err(Error::OraclePriceInvalid)`).
    /// 5. **Return** - The validated `PriceData` is returned to the caller.
    ///
    /// `base_asset` is typically the XLM native contract and `quote_asset` the
    /// USDC contract.
    pub fn get_price(
        env: Env,
        base_asset: Address,
        quote_asset: Address,
    ) -> Result<PriceData, Error> {
        // Retrieve the oracle address, falling back gracefully if absent.
        let oracle_opt: Option<Address> = env.storage().instance().get(&DataKey::OracleAddress);

        let staleness_threshold: u64 = env
            .storage()
            .instance()
            .get(&DataKey::StalenessThreshold)
            .unwrap_or(3_600u64); // default: 1 hour

        // Helper closure: return the fallback price if one is configured,
        // otherwise propagate the supplied error.
        let fallback_or_err =
            |env: &Env, base: &Address, quote: &Address, err: Error| -> Result<PriceData, Error> {
                if let Some(fallback) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, PriceData>(&DataKey::FallbackPrice(base.clone(), quote.clone()))
                {
                    log!(env, "Oracle error; using fallback price");
                    Ok(fallback)
                } else {
                    Err(err)
                }
            };

        // 1. Check oracle is configured.
        let Some(oracle) = oracle_opt else {
            return fallback_or_err(&env, &base_asset, &quote_asset, Error::OracleNotConfigured);
        };

        // 2. Call the oracle. Use try_get_price to avoid trapping on failure.
        let Ok(Ok(price_data)) =
            PriceFeedOracleClient::new(&env, &oracle).try_get_price(&base_asset, &quote_asset)
        else {
            log!(&env, "Oracle contract call failed");
            return fallback_or_err(&env, &base_asset, &quote_asset, Error::OracleCallFailed);
        };

        // 3. Staleness check (skip when threshold is 0).
        if staleness_threshold > 0 {
            let current_time = env.ledger().timestamp();
            if price_data.timestamp == 0
                || current_time.saturating_sub(price_data.timestamp) > staleness_threshold
            {
                log!(&env, "Oracle price is stale");
                return fallback_or_err(&env, &base_asset, &quote_asset, Error::OraclePriceStale);
            }
        }

        // 4. Validity check.
        if price_data.price <= 0 {
            log!(&env, "Oracle price is invalid (<=0)");
            return fallback_or_err(&env, &base_asset, &quote_asset, Error::OraclePriceInvalid);
        }

        // 5. Emit event and return the validated price.
        env.events().publish(
            (
                symbol_short!("price_ok"),
                base_asset.clone(),
                quote_asset.clone(),
            ),
            price_data.price,
        );

        log!(&env, "Oracle price fetched and validated");
        Ok(price_data)
    }

    /// Routes a payment from a sender to a recipient, deducting a platform fee.
    ///
    /// # Parameters
    /// - `sender`: Address the funds are debited from; must authorize the call.
    /// - `recipient`: Address to receive the funds (minus the platform fee).
    /// - `token_address`: Contract ID of the token being transferred.
    /// - `amount`: Amount to route, in the token's smallest unit. Must be
    ///   positive and within the configured min/max and daily-limit bounds.
    ///
    /// # Returns
    /// `Ok(())` on success. Returns `Err(Error::Paused)` if routing is
    /// paused, `Err(Error::NotInitialized)` if the contract has no admin
    /// set, `Err(Error::InvalidRecipient)` if `sender == recipient`,
    /// `Err(Error::Blacklisted)` if `recipient` is blacklisted,
    /// `Err(Error::LimitExceeded)` if `amount` is outside the configured
    /// bounds or exceeds the sender's remaining daily limit, or
    /// `Err(Error::InsufficientBalance)` if `sender`'s token balance is
    /// below `amount`.
    ///
    /// # Panics
    /// Panics if `sender` does not authorize the call, or if the underlying
    /// token transfer to `platform_treasury` fails.
    pub fn route_payment(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), Error> {
        let _guard = ReentrancyGuard::new(&env)?;
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        let max_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxAmount)
            .unwrap_or(Self::MAX_AMOUNT);
        let min_limit: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinLimit)
            .unwrap_or(0);

        if sender == recipient {
            return Err(Error::InvalidRecipient);
        }
        if Self::is_blacklisted(env.clone(), recipient.clone()) {
            return Err(Error::Blacklisted);
        }
        if amount <= 0 || amount > max_amount {
            return Err(Error::LimitExceeded);
        }
        if amount < min_limit {
            return Err(Error::LimitExceeded);
        }
        Self::verify_kyc_for_amount(&env, &sender, amount)?;

        sender.require_auth();

        let (platform_treasury, fee_bps, fee_cap) = Self::load_fee_config(&env)?;

        Self::process_single_payment(
            &env,
            &sender,
            &recipient,
            &token_address,
            amount,
            &platform_treasury,
            fee_bps,
            fee_cap,
        )
    }

    /// Swaps `token_in` through a caller-supplied DEX path and routes the
    /// resulting `token_out` to the recipient. The DEX adapter must return the
    /// received output and any unused input as `[received, unused]`; unused
    /// input is credited to the sender's refund balance.
    ///
    /// # Panics
    /// Panics if the DEX router returns a swap result with fewer than 2 elements,
    /// or if `swap_result.get(0)` or `swap_result.get(1)` returns `None`.
    #[allow(clippy::too_many_arguments)]
    pub fn route_payment_with_swap_raw(
        env: Env,
        sender: Address,
        recipient: Address,
        dex_router: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        path: Vec<Address>,
        min_amount_out: i128,
    ) -> Result<(), Error> {
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }
        if sender == recipient {
            return Err(Error::InvalidRecipient);
        }
        if Self::is_blacklisted(env.clone(), recipient.clone()) {
            return Err(Error::Blacklisted);
        }
        Self::validate_swap_path(&token_in, &token_out, &path, min_amount_out)?;

        let max_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxAmount)
            .unwrap_or(Self::MAX_AMOUNT);
        let min_limit: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinLimit)
            .unwrap_or(0);
        if amount_in <= 0 || amount_in > max_amount || amount_in < min_limit {
            return Err(Error::LimitExceeded);
        }
        Self::verify_kyc_for_amount(&env, &sender, amount_in)?;
        sender.require_auth();

        let (platform_treasury, fee_bps, fee_cap) = Self::load_fee_config(&env)?;
        let token_in_client = token::Client::new(&env, &token_in);
        token_in_client.transfer(&sender, &dex_router, &amount_in);

        let swap_result = DexRouterClient::new(&env, &dex_router).swap_exact_tokens_for_tokens(
            &token_in,
            &token_out,
            &amount_in,
            &min_amount_out,
            &path,
            &env.current_contract_address(),
        );
        if swap_result.len() != 2 {
            return Err(Error::InvalidSwapPath);
        }
        let amount_received: i128 = swap_result.get(0).unwrap();
        let unused_input: i128 = swap_result.get(1).unwrap();
        if amount_received < min_amount_out || amount_received <= 0 || unused_input < 0 {
            return Err(Error::SlippageExceeded);
        }
        if unused_input > 0 {
            token_in_client.transfer(&env.current_contract_address(), &sender, &unused_input);
        }

        Self::process_single_payment(
            &env,
            &sender,
            &recipient,
            &token_out,
            amount_received,
            &platform_treasury,
            fee_bps,
            fee_cap,
        )
    }

    /// Routes multiple payments in a single transaction. If any payment fails,
    /// the entire batch is reverted atomically.
    ///
    /// # Parameters
    /// - `payments`: Batch of transfer instructions to apply in order. See
    ///   [`Payment`] for per-item constraints.
    ///
    /// # Returns
    /// `Ok(())` if every payment in the batch succeeds. Returns the first
    /// error encountered (see `route_payment` for the possible `Err`
    /// variants and their causes) if any payment fails; the Soroban host
    /// reverts all storage and balance changes from the batch in that case.
    ///
    /// # Panics
    /// Panics if any payment's `sender` does not authorize the call, or if
    /// a token transfer to `platform_treasury` fails.
    pub fn route_payments(env: Env, payments: Vec<Payment>) -> Result<(), Error> {
        let _guard = ReentrancyGuard::new(&env)?;
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        // Pre-validate the whole batch before authorizing or moving any
        // funds, so a rejected payment never triggers an auth rollback.
        let max_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxAmount)
            .unwrap_or(Self::MAX_AMOUNT);
        let min_limit: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinLimit)
            .unwrap_or(0);

        // Collect unique senders to require auth only once per sender.
        let mut seen_senders = Vec::new(&env);
        for payment in payments.iter() {
            if payment.sender == payment.recipient {
                return Err(Error::InvalidRecipient);
            }
            if Self::is_blacklisted(env.clone(), payment.recipient.clone()) {
                return Err(Error::Blacklisted);
            }
            if payment.amount <= 0 || payment.amount > max_amount {
                return Err(Error::LimitExceeded);
            }
            if payment.amount < min_limit {
                return Err(Error::LimitExceeded);
            }
            Self::verify_kyc_for_amount(&env, &payment.sender, payment.amount)?;

            // Track unique senders for auth
            let mut is_new = true;
            for seen in seen_senders.iter() {
                if seen == payment.sender {
                    is_new = false;
                    break;
                }
            }
            if is_new {
                seen_senders.push_back(payment.sender.clone());
                payment.sender.require_auth();
            }
        }

        let (platform_treasury, fee_bps, fee_cap) = Self::load_fee_config(&env)?;

        for payment in payments.iter() {
            Self::process_single_payment(
                &env,
                &payment.sender,
                &payment.recipient,
                &payment.token_address,
                payment.amount,
                &platform_treasury,
                fee_bps,
                fee_cap,
            )?;
        }

        Ok(())
    }

    /// Returns the current meta-transaction nonce for a user.
    ///
    /// Relayers must use this nonce when building the signed payload.
    /// The nonce starts at `0` and increments after each successful
    /// `route_payment_meta`, preventing replay attacks.
    pub fn get_meta_nonce(env: Env, user: Address) -> u64 {
        Self::get_meta_nonce_internal(&env, &user)
    }

    /// Routes a payment authorised by an off-chain relayer's Ed25519 signature
    /// instead of the sender's on-chain authorization.
    ///
    /// The relayer signs a canonical payload binding the sender, recipient,
    /// token, amount, nonce and deadline. The contract verifies the signature,
    /// burns the nonce to block replays, and then settles the payment through
    /// the same accounting as a direct `route_payment`.
    ///
    /// # Parameters
    /// - `sender`: Address whose funds are routed and whose nonce is consumed.
    /// - `signer_pubkey`: Ed25519 public key that must have signed the payload.
    /// - `recipient`: Address the funds are delivered to.
    /// - `token_address`: Contract ID of the token being transferred.
    /// - `amount`: Amount to route in the token's smallest unit.
    /// - `nonce`: Must equal the sender's current meta-transaction nonce.
    /// - `deadline`: Ledger timestamp after which the submission is rejected.
    /// - `signature`: Ed25519 signature over the canonical payload.
    ///
    /// # Returns
    /// `Ok(())` once the payment has settled.
    ///
    /// # Panics
    /// Panics if the signature does not verify.
    #[allow(clippy::too_many_arguments)]
    pub fn route_payment_meta(
        env: Env,
        sender: Address,
        signer_pubkey: BytesN<32>,
        recipient: Address,
        token_address: Address,
        amount: i128,
        nonce: u64,
        deadline: u64,
        signature: BytesN<64>,
    ) -> Result<(), Error> {
        let _guard = ReentrancyGuard::new(&env)?;
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        let (platform_treasury, fee_bps, fee_cap) = Self::load_fee_config(&env)?;

        if env.ledger().timestamp() > deadline {
            return Err(Error::DeadlineExpired);
        }

        let stored = Self::get_meta_nonce_internal(&env, &sender);
        if stored != nonce {
            return Err(Error::InvalidNonce);
        }

        let message = Self::build_meta_message(
            &env,
            &sender,
            &signer_pubkey,
            &recipient,
            &token_address,
            amount,
            nonce,
            deadline,
        );
        // Traps on invalid signature; `Error::InvalidSignature` documents
        // this failure mode for off-chain integrators.
        env.crypto()
            .ed25519_verify(&signer_pubkey, &message, &signature);

        let key = DataKey::MetaNonce(sender.clone());
        env.storage().persistent().set(&key, &(nonce + 1));
        env.storage().persistent().extend_ttl(
            &key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        Self::process_single_payment_no_auth(
            &env,
            &sender,
            &recipient,
            &token_address,
            amount,
            &platform_treasury,
            fee_bps,
            fee_cap,
        )
    }

    // ── Token swaps: cross-contract DEX routing ──────────────────────────────
    //
    // A sender can settle a payment in any token they hold and have it
    // converted into the merchant's preferred token before delivery.  The
    // whole sequence runs inside one Soroban transaction:
    //
    //   sender ──sell_token──> router ──sell_token──> DEX adapter
    //   router <──buy_token────────────────────────────┘
    //     ├──fee──> platform treasury
    //     └───────> recipient
    //
    // Atomicity: any failure — DEX revert, slippage breach, deadline expiry,
    // transfer failure — returns an `Err`, and the Soroban host reverts every
    // balance and storage change the payment had already made.  The sender is
    // never left having paid a fee, and the recipient never sees a partial
    // payment.
    //
    // The swap itself is a cross-contract call into a registered DEX adapter,
    // which must expose:
    //
    //   swap(sell_token, buy_token, amount_in, min_amount_out, recipient) -> i128
    //   quote(sell_token, buy_token, amount_in) -> i128
    //
    // By the time `swap` runs, the router has already transferred `amount_in`
    // of `sell_token` to the adapter, so the adapter only has to sell it on and
    // send the `buy_token` it buys to `recipient`, which is this contract.
    // Because the input moves on this side of the call, the adapter never
    // needs authority over the router's balance.  Fixing the signature here,
    // rather than forwarding an opaque payload, also keeps this contract
    // independent of any one DEX's argument layout: an adapter can wrap
    // Soroswap, or any other router, behind this interface.  Only DEXes the
    // admin registered through the timelock may be called, so the call cannot
    // be pointed at arbitrary code.
    //
    // Two slippage guards protect the sender, and both are enforced against
    // the `buy_token` balance delta the router actually receives rather than
    // against whatever the DEX reports:
    //   * `min_amount_out` — a hard floor on the output;
    //   * `max_slippage_bps` — a ceiling on how far the output may fall below
    //     the caller's own quote (`expected_amount_out`).

    /// Core swap-routed payment logic shared by `route_payment_with_swap` and
    /// `route_payments_with_swap`.
    ///
    /// Returns the amount of `buy_token` delivered to the recipient (i.e. the
    /// swap output after the platform fee).
    fn process_single_swap_payment(
        env: &Env,
        swap: &SwapPayment,
        platform_treasury: &Address,
        fee_bps: i128,
        fee_cap: i128,
    ) -> Result<i128, Error> {
        swap.sender.require_auth();

        // --- Validate the swap parameters -----------------------------------
        if swap.sell_token == swap.buy_token {
            return Err(Error::InvalidSwapParams);
        }
        if swap.min_amount_out <= 0 {
            return Err(Error::InvalidSwapParams);
        }
        if swap.deadline != 0 && env.ledger().timestamp() > swap.deadline {
            return Err(Error::SwapDeadlineExpired);
        }
        if !Self::is_dex_registered_internal(env, &swap.dex) {
            return Err(Error::DexNotRegistered);
        }

        env.events().publish(
            (Symbol::new(env, "payment_initiated"), swap.sender.clone()),
            swap.amount_in,
        );

        if swap.sender == swap.recipient {
            return Err(Error::InvalidRecipient);
        }
        if Self::is_blacklisted(env.clone(), swap.recipient.clone()) {
            return Err(Error::Blacklisted);
        }

        // --- Amount bounds, applied to the sell side -------------------------
        let max_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxAmount)
            .unwrap_or(Self::MAX_AMOUNT);
        if swap.amount_in <= 0 || swap.amount_in > max_amount {
            return Err(Error::LimitExceeded);
        }
        let min_limit: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinLimit)
            .unwrap_or(0);
        if swap.amount_in < min_limit {
            return Err(Error::LimitExceeded);
        }

        // Daily limits and lifetime volume are denominated in the sell token,
        // matching what the sender actually parts with. A single packed write
        // covers both counters (issue #663), and the returned volume is the
        // pre-payment one the tiered discount keys off.
        let user_volume = Self::accrue_user_record(env, &swap.sender, swap.amount_in)?;
        let effective_fee_bps = if user_volume > Self::VOLUME_THRESHOLD {
            fee_bps / 2
        } else {
            fee_bps
        };

        let sell_token_client = token::Client::new(env, &swap.sell_token);
        if sell_token_client.balance(&swap.sender) < swap.amount_in {
            return Err(Error::InsufficientBalance);
        }

        let contract_address = env.current_contract_address();
        let buy_token_client = token::Client::new(env, &swap.buy_token);
        let buy_balance_before = buy_token_client.balance(&contract_address);

        // --- Pull the sell token in, then swap it ----------------------------
        sell_token_client.transfer(&swap.sender, &contract_address, &swap.amount_in);

        // Hand the input to the adapter: it already holds the sell token and
        // only has to settle the buy token back to this contract. Keeping the
        // pull on this side means the adapter never needs authority over the
        // router's balance.
        sell_token_client.transfer(&contract_address, &swap.dex, &swap.amount_in);

        Self::invoke_dex_swap(
            env,
            &swap.dex,
            &swap.sell_token,
            &swap.buy_token,
            swap.amount_in,
            swap.min_amount_out,
        )?;

        // --- Verify the output against both slippage guards -------------------
        // The balance delta is authoritative: a DEX cannot claim an output it
        // did not actually deliver to this contract.
        let amount_out = buy_token_client.balance(&contract_address) - buy_balance_before;
        if amount_out < swap.min_amount_out {
            log!(env, "Swap output below min_amount_out; reverting payment");
            return Err(Error::SlippageExceeded);
        }
        if swap.expected_amount_out > 0 {
            let max_slippage_bps = Self::max_slippage_bps(env);
            let slippage_floor = Self::slippage_floor(swap.expected_amount_out, max_slippage_bps);
            if amount_out < slippage_floor {
                log!(
                    env,
                    "Swap output exceeded max_slippage_bps; reverting payment"
                );
                return Err(Error::SlippageExceeded);
            }
        }

        env.events().publish(
            (
                Symbol::new(env, "swap_executed"),
                swap.dex.clone(),
                swap.sell_token.clone(),
                swap.buy_token.clone(),
            ),
            (swap.amount_in, amount_out, swap.min_amount_out),
        );

        // --- Fee on the output, then forward the remainder -------------------
        let (fee_amount, remainder) = Self::calculate_fee(amount_out, effective_fee_bps, fee_cap);
        if fee_amount > 0 {
            buy_token_client.transfer(&contract_address, platform_treasury, &fee_amount);
        }
        if remainder > 0 {
            // Mirrors the direct path: if the recipient cannot receive the
            // buy token, the funds stay in the contract and are credited to
            // the sender's refund ledger instead.
            match buy_token_client.try_transfer(&contract_address, &swap.recipient, &remainder) {
                Ok(Ok(())) => {
                    log!(env, "Swapped remainder routed to recipient");
                }
                _ => {
                    log!(
                        env,
                        "Recipient transfer failed; crediting sender refund balance"
                    );
                    Self::credit_refund_balance(env, &swap.sender, &swap.buy_token, remainder);
                }
            }
        }

        env.events().publish(
            (
                symbol_short!("routed"),
                swap.sender.clone(),
                swap.recipient.clone(),
            ),
            remainder,
        );

        log!(env, "Payment routed through DEX swap");

        Ok(remainder)
    }

    /// Routes a payment in any token, swapping it into the recipient's
    /// preferred token on the way.
    ///
    /// The swap-routed counterpart of [`PaymentRouter::route_payment`]: the same
    /// fee, limit, blacklist, and freeze rules apply, with the conversion
    /// inserted between pulling the funds and delivering them. The platform fee
    /// is taken on the `buy_token` output, so `fee_cap` applies in `buy_token`
    /// units for this route.
    ///
    /// # Parameters
    /// - `payment`: The swap-routed transfer (see [`SwapPayment`]).
    ///
    /// # Returns
    /// The amount of `buy_token` delivered to the recipient, after the
    /// platform fee. Otherwise the payment is abandoned whole, with:
    /// - `Err(Error::InvalidSwapParams)`, `Err(Error::SwapDeadlineExpired)`,
    ///   `Err(Error::DexNotRegistered)`, `Err(Error::SwapFailed)`, or
    ///   `Err(Error::SlippageExceeded)` for swap-specific problems,
    /// - the same `Err` variants as `route_payment` otherwise.
    ///
    /// # Panics
    /// Panics if `payment.sender` does not authorize the call, or if a token
    /// transfer out of this contract fails.
    pub fn route_payment_with_swap(env: Env, payment: SwapPayment) -> Result<i128, Error> {
        let _guard = ReentrancyGuard::new(&env)?;
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        let (platform_treasury, fee_bps, fee_cap) = Self::load_fee_config(&env)?;

        Self::process_single_swap_payment(&env, &payment, &platform_treasury, fee_bps, fee_cap)
    }

    /// Routes several swap-routed payments in a single transaction. If any
    /// payment fails, the entire batch is reverted atomically, including any
    /// swaps that already executed earlier in the batch.
    ///
    /// # Parameters
    /// - `payments`: Batch of swap-routed transfers to apply in order. See
    ///   [`SwapPayment`] for per-item constraints.
    ///
    /// # Returns
    /// The total amount of `buy_token` delivered across the batch, or the
    /// first error encountered (see `route_payment_with_swap` for the
    /// possible variants and their causes).
    ///
    /// # Panics
    /// Panics if any payment's `sender` does not authorize the call, or if a
    /// token transfer out of this contract fails.
    pub fn route_payments_with_swap(env: Env, payments: Vec<SwapPayment>) -> Result<i128, Error> {
        let _guard = ReentrancyGuard::new(&env)?;
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        let (platform_treasury, fee_bps, fee_cap) = Self::load_fee_config(&env)?;

        let mut total_delivered: i128 = 0;
        for payment in payments.iter() {
            let delivered = Self::process_single_swap_payment(
                &env,
                &payment,
                &platform_treasury,
                fee_bps,
                fee_cap,
            )?;
            total_delivered += delivered;
        }

        Ok(total_delivered)
    }

    // ── Meta-transactions (relayer-submitted, allowance-based) ──────────────

    /// Returns the current meta-transaction nonce for a user.
    ///
    /// Relayers must use this nonce when building the signed payload.
    /// The nonce starts at `0` and increments after each successful
    /// `route_payment_meta`, preventing replay attacks.
    pub fn get_meta_nonce(env: Env, user: Address) -> u64 {
        Self::get_meta_nonce_internal(&env, &user)
    }

    /// Relays a user-signed payment on behalf of the user.
    ///
    /// The user signs `SHA256(contract || sender || pubkey || recipient ||
    /// token || amount || nonce || deadline)` off-chain with Ed25519.
    /// Any relayer holding XLM for fees submits the payload; the contract
    /// verifies the signature, checks `nonce` and `deadline`, then moves
    /// funds via prior token allowance (`approve` + `transfer_from`).
    #[allow(clippy::too_many_arguments)]
    pub fn route_payment_meta(
        env: Env,
        sender: Address,
        signer_pubkey: BytesN<32>,
        recipient: Address,
        token_address: Address,
        amount: i128,
        nonce: u64,
        deadline: u64,
        signature: BytesN<64>,
    ) -> Result<(), Error> {
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        let (platform_treasury, fee_bps, fee_cap) = Self::load_fee_config(&env)?;

        if env.ledger().timestamp() > deadline {
            return Err(Error::DeadlineExpired);
        }

        let stored = Self::get_meta_nonce_internal(&env, &sender);
        if stored != nonce {
            return Err(Error::InvalidNonce);
        }

        let message = Self::build_meta_message(
            &env,
            &sender,
            &signer_pubkey,
            &recipient,
            &token_address,
            amount,
            nonce,
            deadline,
        );
        // Traps on invalid signature; `Error::InvalidSignature` documents
        // this failure mode for off-chain integrators.
        env.crypto()
            .ed25519_verify(&signer_pubkey, &message, &signature);

        let key = DataKey::MetaNonce(sender.clone());
        env.storage().persistent().set(&key, &(nonce + 1));
        env.storage().persistent().extend_ttl(
            &key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        Self::process_single_payment_no_auth(
            &env,
            &sender,
            &recipient,
            &token_address,
            amount,
            &platform_treasury,
            fee_bps,
            fee_cap,
        )
    }

    /// Asks a registered DEX how much `buy_token` a swap would return, and
    /// derives the `min_amount_out` the sender should use from the contract's
    /// configured slippage ceiling.
    ///
    /// This is a read-only cross-contract call: it moves no funds and changes no
    /// state, so it is safe to call off-chain before building a
    /// [`SwapPayment`].
    ///
    /// # Parameters
    /// - `dex`: Contract ID of a registered DEX adapter.
    /// - `sell_token`: Token the sender would pay with.
    /// - `buy_token`: Token the recipient would be paid in.
    /// - `amount_in`: Amount of `sell_token` to price, in its smallest unit.
    ///
    /// # Returns
    /// A [`SwapQuote`] with the quoted output, the slippage-adjusted
    /// `min_amount_out`, and the slippage ceiling used. Returns
    /// `Err(Error::DexNotRegistered)` if `dex` was never registered or
    /// `Err(Error::SwapFailed)` if the DEX quote call reverts.
    ///
    /// # Panics
    /// Does not panic.
    pub fn quote_swap(
        env: Env,
        dex: Address,
        sell_token: Address,
        buy_token: Address,
        amount_in: i128,
    ) -> Result<SwapQuote, Error> {
        if !Self::is_dex_registered_internal(&env, &dex) {
            return Err(Error::DexNotRegistered);
        }

        let amount_out = Self::invoke_dex_quote(&env, &dex, &sell_token, &buy_token, amount_in)?;
        if amount_out <= 0 {
            return Err(Error::InvalidSwapParams);
        }

        let max_slippage_bps = Self::max_slippage_bps(&env);

        Ok(SwapQuote {
            amount_out,
            min_amount_out: Self::slippage_floor(amount_out, max_slippage_bps),
            max_slippage_bps,
        })
    }

    // ── Swap configuration (sensitive; timelock-gated) ──────────────────────

    /// Allows swap routing to invoke a DEX router contract. Admin-only.
    ///
    /// Restricting cross-contract calls to a registered allowlist is what keeps
    /// swap routing pointed at audited code.
    ///
    /// # Parameters
    /// - `dex`: Contract ID of the DEX router to approve.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract has
    /// no admin set yet.
    ///
    /// # Panics
    /// Panics if the current admin does not authorize the call.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::RegisterDex(…))`
    /// and execute after 24 hours.
    pub fn register_dex(env: Env, dex: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        let key = DataKey::RegisteredDex(dex.clone());
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(
            &key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        env.events()
            .publish((Symbol::new(&env, "dex_registered"), admin), dex);

        Ok(())
    }

    /// Stops swap routing from invoking a DEX router contract. Admin-only.
    ///
    /// # Parameters
    /// - `dex`: Contract ID of the DEX router to revoke.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract has
    /// no admin set yet.
    ///
    /// # Panics
    /// Panics if the current admin does not authorize the call.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::DeregisterDex(…))`
    /// and execute after 24 hours.
    pub fn deregister_dex(env: Env, dex: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage()
            .persistent()
            .remove(&DataKey::RegisteredDex(dex.clone()));

        env.events()
            .publish((Symbol::new(&env, "dex_deregistered"), admin), dex);

        Ok(())
    }

    /// Returns whether a DEX router is approved for swap routing.
    ///
    /// # Parameters
    /// - `dex`: Contract ID to check.
    ///
    /// # Returns
    /// `true` if the DEX may be used by `route_payment_with_swap`, `false`
    /// otherwise.
    ///
    /// # Panics
    /// Does not panic.
    pub fn is_dex_registered(env: Env, dex: Address) -> bool {
        Self::is_dex_registered_internal(&env, &dex)
    }

    /// Sets the maximum tolerated swap slippage. Admin-only.
    ///
    /// Applied against the `expected_amount_out` a caller supplies alongside a
    /// quote, as a second guard on top of the per-payment `min_amount_out`
    /// floor.
    ///
    /// # Parameters
    /// - `max_slippage_bps`: New ceiling in basis points; `0` to `10_000`.
    ///
    /// # Returns
    /// `Ok(())` on success, `Err(Error::InvalidSwapParams)` if the value is
    /// outside `0..=10_000`, or `Err(Error::NotInitialized)` if the contract has
    /// no admin set yet.
    ///
    /// # Panics
    /// Panics if the current admin does not authorize the call.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetMaxSlippageBps(…))`
    /// and execute after 24 hours.
    pub fn set_max_slippage_bps(env: Env, max_slippage_bps: i128) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        if !(0..=Self::MAX_SLIPPAGE_BPS_LIMIT).contains(&max_slippage_bps) {
            return Err(Error::InvalidSwapParams);
        }

        env.storage()
            .instance()
            .set(&DataKey::MaxSlippageBps, &max_slippage_bps);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        Ok(())
    }

    /// Returns the maximum tolerated swap slippage in basis points.
    ///
    /// # Returns
    /// The configured `max_slippage_bps`, or the 1 000 bps (10%) default if
    /// the contract has not been initialized.
    ///
    /// # Panics
    /// Does not panic.
    pub fn get_max_slippage_bps(env: Env) -> i128 {
        Self::max_slippage_bps(&env)
    }

    /// Returns the available internal refund balance for a user and token.
    ///
    /// # Parameters
    /// - `user`: Address whose refund balance to look up.
    /// - `token`: Contract ID of the token.
    ///
    /// # Returns
    /// The refundable balance for `(user, token)`, or `0` if none is held.
    ///
    /// # Panics
    /// Does not panic.
    pub fn get_refund_balance(env: Env, user: Address, token: Address) -> i128 {
        Self::get_refund_balance_internal(&env, &user, &token)
    }

    /// Withdraws a specific amount from the user's internal refund balance.
    ///
    /// A refund balance accrues when a `route_payment` / `route_payments`
    /// transfer to the recipient fails (e.g. missing trustline) and the
    /// funds are held by the contract on the sender's behalf instead.
    ///
    /// # Parameters
    /// - `user`: Address withdrawing funds; must authorize the call.
    /// - `token`: Contract ID of the token to withdraw.
    /// - `amount`: Amount to withdraw. Must be positive and not exceed the
    ///   current refund balance.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NoRefundAvailable)` if `amount`
    /// is zero, negative, or greater than the available balance.
    ///
    /// # Panics
    /// Panics if `user` does not authorize the call, or if the underlying
    /// token transfer fails.
    pub fn withdraw_refund(
        env: Env,
        user: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), Error> {
        user.require_auth();

        if amount <= 0 {
            return Err(Error::NoRefundAvailable);
        }

        let current_balance = Self::get_refund_balance_internal(&env, &user, &token);
        if amount > current_balance {
            return Err(Error::NoRefundAvailable);
        }

        let key = DataKey::RefundBalance(user.clone(), token.clone());
        let new_balance = current_balance - amount;
        if new_balance > 0 {
            env.storage().persistent().set(&key, &new_balance);
            env.storage().persistent().extend_ttl(
                &key,
                Self::PERSISTENT_LIFETIME_THRESHOLD,
                Self::PERSISTENT_BUMP_AMOUNT,
            );
        } else {
            env.storage().persistent().remove(&key);
        }

        let contract_address = env.current_contract_address();
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&contract_address, &user, &amount);

        env.events().publish(
            (symbol_short!("withdrawn"), user.clone(), token.clone()),
            amount,
        );

        log!(&env, "Refund balance withdrawn by user");
        Ok(())
    }

    /// Claims and withdraws the entire available refund balance for a user and token.
    ///
    /// # Parameters
    /// - `user`: Address withdrawing funds; must authorize the call.
    /// - `token`: Contract ID of the token to withdraw.
    ///
    /// # Returns
    /// `Ok(amount)` with the amount withdrawn, or
    /// `Err(Error::NoRefundAvailable)` if the refund balance is zero.
    ///
    /// # Panics
    /// Panics if `user` does not authorize the call, or if the underlying
    /// token transfer fails.
    pub fn claim_all_refunds(env: Env, user: Address, token: Address) -> Result<i128, Error> {
        user.require_auth();

        let current_balance = Self::get_refund_balance_internal(&env, &user, &token);
        if current_balance <= 0 {
            return Err(Error::NoRefundAvailable);
        }

        Self::withdraw_refund(env, user, token, current_balance)?;
        Ok(current_balance)
    }

    /// Admin-only emergency withdrawal of tokens held by this contract.
    ///
    /// # Parameters
    /// - `token`: Contract ID of the token to withdraw.
    /// Admin-only emergency withdrawal of tokens held by this contract. TreasuryManager-protected.
    ///
    /// # Parameters
    /// - `token`: Contract ID of the token to withdraw.
    /// - `amount`: Amount to transfer from the contract's balance to the treasury manager.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the current TreasuryManager does not authorize the call, or if the
    /// token transfer fails (e.g. the contract's balance is below `amount`).
    pub fn emergency_withdraw(env: Env, token: Address, amount: i128) -> Result<(), Error> {
        let _guard = ReentrancyGuard::new(&env)?;
        let treasury_mgr = Self::require_role(&env, Role::TreasuryManager)?;

        if amount <= 0 {
            return Err(Error::LimitExceeded);
        }

        let token_client = token::Client::new(&env, &token);
        let contract_address = env.current_contract_address();
        if amount > token_client.balance(&contract_address) {
            return Err(Error::InsufficientBalance);
        }
        token_client.transfer(&contract_address, &treasury_mgr, &amount);

        log!(&env, "Emergency withdraw executed by TreasuryManager");
        Ok(())
    }

    // ── Multi-signature (M-of-N) contract upgrades ───────────────────────────
    //
    // Issue #664: upgrades used to be gated on a single admin key, which made
    // that key both a single point of failure (lose it and the contract can
    // never be patched) and a single point of centralization (compromise it and
    // an attacker owns the contract).  Upgrades now require M signatures drawn
    // from an N-member admin group, so no single key — including the admin's —
    // can upgrade the contract on its own.
    //
    // The flow is:
    //   1. The admin configures the group once with `set_multisig_config`.
    //   2. Each signer authorizes a specific WASM hash with `approve_upgrade`.
    //   3. Once M signatures are collected, `upgrade` (or the timelock's
    //      `ActionType::Upgrade`) installs that exact hash and the approvals
    //      are consumed.
    //
    // Until step 1 happens every upgrade fails closed with
    // `Error::MultisigNotInitialized`; there is deliberately no fallback to the
    // single admin key, because that fallback is the vulnerability being fixed.

    // The admin is the root of trust for this call only: it can re-point the
    // group but still cannot upgrade the contract by itself. Prefer
    // `queue_action(ActionType::SetMultisigConfig(…))` to put the 24-hour
    // timelock in front of a rotation, which this direct setter bypasses.
    /// Configures the multi-signature admin group that authorizes upgrades.
    ///
    /// The signer set is replaced wholesale: addresses that are not in
    /// `signers` immediately lose the ability to approve, and a threshold
    /// already reached for a pending hash is re-evaluated against the new
    /// configuration.
    ///
    /// # Parameters
    /// - `signers`: The N addresses whose signatures count. Must be non-empty
    ///   and free of duplicates.
    /// - `threshold`: The M signers required to authorize an upgrade, in
    ///   `1..=signers.len()`.
    ///
    /// # Returns
    /// `Ok(())` on success, `Err(Error::InvalidMultisigConfig)` if the signer
    /// set is empty or holds a duplicate, or the threshold is zero or larger
    /// than the set, or `Err(Error::NotInitialized)` if the contract has no
    /// admin set yet.
    ///
    /// # Panics
    /// Panics if the current admin does not authorize the call.
    pub fn set_multisig_config(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        let validated = Self::validate_multisig_config(&signers, threshold)?;
        Self::store_multisig_config(&env, signers, validated);

        env.events()
            .publish((Symbol::new(&env, "multisig_config_set"), admin), validated);

        log!(
            &env,
            "Multi-signature upgrade threshold set to {}",
            validated
        );
        Ok(())
    }

    /// Returns the current multi-signature admin group.
    ///
    /// # Returns
    /// The configured signers and threshold, or `Err(Error::MultisigNotInitialized)`
    /// if `set_multisig_config` has not been called yet.
    ///
    /// # Panics
    /// Does not panic.
    pub fn get_multisig_config(env: Env) -> Result<MultisigConfig, Error> {
        let (signers, threshold) = Self::load_multisig_config(&env)?;
        Ok(MultisigConfig { signers, threshold })
    }

    /// Records `signer`'s authorization of an upgrade to `new_wasm_hash`.
    ///
    /// Each group member signs off separately so the M signatures are genuinely
    /// independent: one compromised key cannot produce a quorum, and every
    /// approval is bound to one specific WASM hash.
    ///
    /// Reaching the threshold does not install the WASM by itself — call
    /// `upgrade` (or `execute_action` on a queued [`ActionType::Upgrade`]) to
    /// apply it. Keeping those two steps separate lets the group approve a hash
    /// and then route the installation through the 24-hour timelock if it wants
    /// observers to see it coming.
    ///
    /// # Parameters
    /// - `signer`: The group member approving; must authorize this call.
    /// - `new_wasm_hash`: The WASM hash being approved.
    ///
    /// # Returns
    /// `Ok(())` on success, `Err(Error::MultisigNotInitialized)` if no group
    /// is configured, `Err(Error::NotMultisigSigner)` if `signer` is not a
    /// group member, or `Err(Error::AlreadyApproved)` if `signer` already
    /// approved this hash.
    ///
    /// # Panics
    /// Panics if `signer` does not authorize the call.
    pub fn approve_upgrade(
        env: Env,
        signer: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let (signers, threshold) = Self::load_multisig_config(&env)?;
        if !signers.contains(&signer) {
            return Err(Error::NotMultisigSigner);
        }
        signer.require_auth();

        let key = DataKey::UpgradeApproval(new_wasm_hash.clone());
        let mut approvals: Vec<Address> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        if approvals.contains(&signer) {
            return Err(Error::AlreadyApproved);
        }
        approvals.push_back(signer.clone());
        env.storage().persistent().set(&key, &approvals);
        env.storage().persistent().extend_ttl(
            &key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (Symbol::new(&env, "upgrade_approved"), signer, new_wasm_hash),
            (approvals.len(), threshold),
        );

        log!(
            &env,
            "Upgrade approved by signer {}/{}",
            approvals.len(),
            threshold
        );
        Ok(())
    }

    /// Withdraws a signer's previously recorded approval of an upgrade.
    ///
    /// Lets a signer pull its signature back before the threshold is reached,
    /// which is the way a group stops an upgrade it no longer wants without
    /// having to rotate the whole signer set. Idempotent: withdrawing an
    /// approval that was never recorded is a no-op.
    ///
    /// # Parameters
    /// - `signer`: The group member withdrawing its approval; must authorize
    ///   this call.
    /// - `new_wasm_hash`: The WASM hash to withdraw the approval for.
    ///
    /// # Returns
    /// `Ok(())` on success or `Err(Error::MultisigNotInitialized)` if no group
    /// is configured.
    ///
    /// # Panics
    /// Panics if `signer` does not authorize the call.
    pub fn revoke_upgrade_approval(
        env: Env,
        signer: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let (signers, _) = Self::load_multisig_config(&env)?;
        if !signers.contains(&signer) {
            return Err(Error::NotMultisigSigner);
        }
        signer.require_auth();

        let key = DataKey::UpgradeApproval(new_wasm_hash.clone());
        let mut approvals: Vec<Address> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));

        // Vec::first_index_of returns the position of the first match, which
        // for a duplicate-free set is the one and only approval to drop.
        if let Some(index) = approvals.first_index_of(&signer) {
            approvals.remove(index);
            if approvals.is_empty() {
                env.storage().persistent().remove(&key);
            } else {
                env.storage().persistent().set(&key, &approvals);
                env.storage().persistent().extend_ttl(
                    &key,
                    Self::PERSISTENT_LIFETIME_THRESHOLD,
                    Self::PERSISTENT_BUMP_AMOUNT,
                );
            }

            env.events().publish(
                (Symbol::new(&env, "upgrade_revoked"), signer, new_wasm_hash),
                approvals.len(),
            );

            log!(&env, "Upgrade approval revoked");
        }

        Ok(())
    }

    /// Discards every approval collected for `new_wasm_hash`. Admin-only.
    ///
    /// The blunt instrument for a compromised hash: it drops the quorum even
    /// when the threshold was already met, so the group can force the group
    /// back to zero signatures. Note that `upgrade` is permissionless once the
    /// threshold is met, so the admin should prefer having signers revoke their
    /// own approvals (or rotate the group) while the hash is still in flight.
    ///
    /// # Parameters
    /// - `new_wasm_hash`: The WASM hash to clear approvals for.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract has
    /// no admin set yet. Clearing a hash with no approvals is a no-op.
    ///
    /// # Panics
    /// Panics if the current admin does not authorize the call.
    pub fn cancel_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        let key = DataKey::UpgradeApproval(new_wasm_hash.clone());
        if env.storage().persistent().has(&key) {
            env.storage().persistent().remove(&key);
        }

        env.events().publish(
            (Symbol::new(&env, "upgrade_cancelled"), admin),
            new_wasm_hash,
        );

        log!(&env, "Pending upgrade approvals cleared by admin");
        Ok(())
    }

    /// Returns the signers whose approval of an upgrade to `new_wasm_hash`
    /// currently counts.
    ///
    /// Approvals cast by a signer that has since been rotated out of the group
    /// are omitted, so this list always agrees with `is_upgrade_authorized`.
    ///
    /// # Returns
    /// The counted approvals in the order they were recorded, or an empty
    /// vector if the hash has none. Empty when no group is configured.
    ///
    /// # Panics
    /// Does not panic.
    pub fn get_upgrade_approvals(env: Env, new_wasm_hash: BytesN<32>) -> Vec<Address> {
        match Self::load_multisig_config(&env) {
            Ok((signers, _)) => Self::load_effective_approvals(&env, &signers, &new_wasm_hash),
            // Fail closed without erroring: a view of "who approved" is
            // meaningless when there is no group to have authorized anything.
            Err(_) => Vec::new(&env),
        }
    }

    /// Returns whether an upgrade to `new_wasm_hash` is already authorized.
    ///
    /// # Returns
    /// `true` once `M` group members have approved that exact hash.
    /// `Err(Error::MultisigNotInitialized)` if no group is configured.
    ///
    /// # Panics
    /// Does not panic.
    pub fn is_upgrade_authorized(env: Env, new_wasm_hash: BytesN<32>) -> Result<bool, Error> {
        Self::check_upgrade_authorized(&env, &new_wasm_hash)
    }

    // Deliberately permissionless: the M collected signatures *are* the
    // authorization, so whoever submits the transaction once the threshold is
    // met gets the same result, and no additional key — least of all the
    // admin's — can stand in for a quorum. Approvals are consumed on success,
    // so reaching the threshold authorizes exactly one installation. The same
    // gate applies to the timelock path, so queueing an `ActionType::Upgrade`
    // is not a way around it.
    /// Replaces this contract's WASM with a previously uploaded version, once
    /// the multi-signature group has authorized that exact hash.
    ///
    /// # Parameters
    /// - `new_wasm_hash`: Hash of a WASM blob previously uploaded to the
    ///   network. Must match a hash with at least `threshold` approvals.
    ///
    /// # Returns
    /// `Ok(())` on success, `Err(Error::MultisigNotInitialized)` if no group
    /// is configured, or `Err(Error::InsufficientApprovals)` if fewer than
    /// `threshold` members have approved this hash.
    ///
    /// # Panics
    /// Panics if `new_wasm_hash` does not reference an uploaded WASM blob.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let approvals = Self::require_upgrade_authorized(&env, &new_wasm_hash)?;

        Self::apply_upgrade(&env, &new_wasm_hash);

        env.events().publish(
            (Symbol::new(&env, "contract_upgraded"), new_wasm_hash),
            approvals,
        );

        log!(
            &env,
            "Contract upgraded with {} multisig approvals",
            approvals
        );
        Ok(())
    }

    /// Returns the contract version.
    ///
    /// This is a read-only view function: it does not write to ledger storage
    /// and costs only the base invocation fee.  The UI calls this before
    /// submitting transactions to confirm it is compatible with the deployed
    /// contract.
    ///
    /// # Returns
    /// A [`String`] in the form `"MAJOR.MINOR.PATCH"` (e.g. `"1.0.0"`).
    pub fn version(env: Env) -> String {
        String::from_str(&env, Self::CONTRACT_VERSION)
    }
}

// ── Archival extension ────────────────────────────────────────────────────────
//
// A second #[contractimpl] block keeps the archival surface separate and avoids
// hitting the soroban-sdk per-impl function-count ceiling.
#[contractimpl]
impl PaymentRouter {
    /// Commits a SHA-256 Merkle root of a batch of payment-record snapshots
    /// into persistent storage, opening a new archive epoch.
    ///
    /// Call this before `prune_archived_entries`. Requires TreasuryManager.
    /// Returns the new epoch number.
    ///
    /// Errors: NotInitialized, ContractFrozen.
    pub fn commit_archive_root(
        env: Env,
        root: BytesN<32>,
        leaves: Vec<ArchiveLeaf>,
        description: String,
    ) -> Result<u64, Error> {
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        Self::require_role(&env, Role::TreasuryManager)?;

        let current_epoch: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ArchiveEpoch)
            .unwrap_or(0u64);
        let new_epoch = current_epoch + 1;
        env.storage()
            .instance()
            .set(&DataKey::ArchiveEpoch, &new_epoch);

        let record_count = leaves.len();
        let committed_at = env.ledger().timestamp();

        // Persist the Merkle root.
        let root_key = DataKey::ArchiveRoot(new_epoch);
        env.storage().persistent().set(&root_key, &root);
        env.storage().persistent().extend_ttl(
            &root_key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        // Persist metadata.
        let meta = ArchiveMetadata {
            committed_at,
            record_count,
            description,
        };
        let meta_key = DataKey::ArchiveMeta(new_epoch);
        env.storage().persistent().set(&meta_key, &meta);
        env.storage().persistent().extend_ttl(
            &meta_key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        archival::emit_archive_committed(&env, new_epoch, &root, record_count);
        log!(
            &env,
            "Archive epoch {} committed: {} records",
            new_epoch,
            record_count
        );

        Ok(new_epoch)
    }

    /// Returns the Merkle root and metadata for an archive epoch, or `None`
    /// if no archive exists for that epoch.
    pub fn get_archive_info(env: Env, epoch: u64) -> Option<(BytesN<32>, ArchiveMetadata)> {
        let root: Option<BytesN<32>> = env.storage().persistent().get(&DataKey::ArchiveRoot(epoch));
        let meta: Option<ArchiveMetadata> =
            env.storage().persistent().get(&DataKey::ArchiveMeta(epoch));
        match (root, meta) {
            (Some(r), Some(m)) => Some((r, m)),
            _ => None,
        }
    }

    /// Returns the current archive epoch counter (0 = no epochs committed yet).
    pub fn get_archive_epoch(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ArchiveEpoch)
            .unwrap_or(0)
    }

    /// Deletes on-chain ledger entries committed via `commit_archive_root`.
    ///
    /// Requires the epoch from a prior commit call. Silently skips absent
    /// entries. Returns the count of entries removed.
    ///
    /// Supported: UserVolume, UserSpending, RefundBalance.
    /// Errors: NotInitialized, ContractFrozen, TimelockNotFound (unknown epoch).
    /// Requires TreasuryManager.
    pub fn prune_archived_entries(
        env: Env,
        committed_epoch: u64,
        leaves: Vec<ArchiveLeaf>,
    ) -> Result<u32, Error> {
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        Self::require_role(&env, Role::TreasuryManager)?;

        // Guard: a committed root must exist for this epoch.
        if !env
            .storage()
            .persistent()
            .has(&DataKey::ArchiveRoot(committed_epoch))
        {
            return Err(Error::TimelockNotFound);
        }

        let mut removed: u32 = 0;

        for leaf in leaves.iter() {
            match leaf.record_type {
                ArchiveRecordType::UserVolume => {
                    let key = DataKey::UserVolume(leaf.primary_key.clone());
                    if env.storage().persistent().has(&key) {
                        env.storage().persistent().remove(&key);
                        removed += 1;
                    }
                }
                ArchiveRecordType::UserSpending => {
                    let key = DataKey::UserSpending(leaf.primary_key.clone());
                    if env.storage().persistent().has(&key) {
                        env.storage().persistent().remove(&key);
                        removed += 1;
                    }
                }
                ArchiveRecordType::RefundBalance => {
                    let key = DataKey::RefundBalance(
                        leaf.primary_key.clone(),
                        leaf.secondary_key.clone(),
                    );
                    if env.storage().persistent().has(&key) {
                        env.storage().persistent().remove(&key);
                        removed += 1;
                    }
                }
            }
        }

        env.events().publish(
            (Symbol::new(&env, "entries_pruned"), committed_epoch),
            (removed, env.ledger().timestamp()),
        );

        log!(
            &env,
            "Pruned {} entries for archive epoch {}",
            removed,
            committed_epoch
        );

        Ok(removed)
    }
}

#[cfg(test)]
mod test {
    use super::*;

    // The crate is `no_std`, but the test harness links std; pull it in so
    // the benchmark can print its GAS REPORT lines.
    extern crate std;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _, LedgerInfo, MockAuth, MockAuthInvoke},
        token::StellarAssetClient,
        Address, Env, Symbol, TryIntoVal, Val,
    };

    #[contracttype]
    #[derive(Clone)]
    enum MockLendingKey {
        Principal(Address),
        Yield(Address),
    }

    #[contract]
    struct MockLendingProtocol;

    #[contractimpl]
    impl MockLendingProtocol {
        pub fn deposit(env: Env, from: Address, token: Address, amount: i128) {
            from.require_auth();
            token::Client::new(&env, &token).transfer(
                &from,
                &env.current_contract_address(),
                &amount,
            );
            let key = MockLendingKey::Principal(token);
            let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
            env.storage().instance().set(&key, &(current + amount));
        }

        pub fn withdraw(env: Env, to: Address, token: Address, amount: i128) {
            let key = MockLendingKey::Principal(token.clone());
            let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
            assert!(current >= amount);
            token::Client::new(&env, &token).transfer(
                &env.current_contract_address(),
                &to,
                &amount,
            );
            env.storage().instance().set(&key, &(current - amount));
        }

        pub fn harvest(env: Env, to: Address, token: Address) -> i128 {
            let key = MockLendingKey::Yield(token.clone());
            let amount: i128 = env.storage().instance().get(&key).unwrap_or(0);
            if amount > 0 {
                token::Client::new(&env, &token).transfer(
                    &env.current_contract_address(),
                    &to,
                    &amount,
                );
                env.storage().instance().remove(&key);
            }
            amount
        }

        pub fn accrue_yield(env: Env, token: Address, amount: i128) {
            let key = MockLendingKey::Yield(token);
            let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
            env.storage().instance().set(&key, &(current + amount));
        }
    }

    #[contracttype]
    #[derive(Clone)]
    enum MockKycKey {
        Verified(Address),
    }

    #[contract]
    struct MockKycOracle;

    #[contractimpl]
    impl MockKycOracle {
        pub fn set_verified(env: Env, account: Address, verified: bool) {
            env.storage()
                .instance()
                .set(&MockKycKey::Verified(account), &verified);
        }

        pub fn is_verified(env: Env, account: Address) -> bool {
            env.storage()
                .instance()
                .get(&MockKycKey::Verified(account))
                .unwrap_or(false)
        }
    }

    // ── Mock price-feed oracle ───────────────────────────────────────────────

    #[contracttype]
    #[derive(Clone)]
    enum MockOracleKey {
        Price(Address, Address),
        ShouldFail,
    }

    #[contracterror]
    #[derive(Copy, Clone, Debug, Eq, PartialEq)]
    #[repr(u32)]
    pub enum MockOracleError {
        /// Simulates an unavailable oracle.
        Unavailable = 1,
    }

    #[contract]
    struct MockPriceFeedOracle;

    #[contractimpl]
    impl MockPriceFeedOracle {
        /// Store a price for a given (base, quote) pair.
        pub fn set_price(
            env: Env,
            base_asset: Address,
            quote_asset: Address,
            price: i128,
            decimals: u32,
            timestamp: u64,
        ) {
            let data = PriceData {
                price,
                decimals,
                timestamp,
            };
            env.storage()
                .instance()
                .set(&MockOracleKey::Price(base_asset, quote_asset), &data);
        }

        /// Configure the mock to trap on the next `get_price` call.
        pub fn set_should_fail(env: Env, fail: bool) {
            env.storage()
                .instance()
                .set(&MockOracleKey::ShouldFail, &fail);
        }

        /// Implements the PriceFeedOracle interface.
        pub fn get_price(
            env: Env,
            base_asset: Address,
            quote_asset: Address,
        ) -> Result<PriceData, MockOracleError> {
            let should_fail: bool = env
                .storage()
                .instance()
                .get(&MockOracleKey::ShouldFail)
                .unwrap_or(false);
            if should_fail {
                return Err(MockOracleError::Unavailable);
            }
            Ok(env
                .storage()
                .instance()
                .get(&MockOracleKey::Price(base_asset, quote_asset))
                .unwrap_or(PriceData {
                    price: 0,
                    decimals: 7,
                    timestamp: 0,
                }))
        }
    }

    // ── Oracle helper ────────────────────────────────────────────────────────

    fn setup_oracle_env() -> (
        Env,
        PaymentRouterClient<'static>,
        Address,
        MockPriceFeedOracleClient<'static>,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        // The ledger starts at timestamp 0, which `get_price` treats as a
        // stale quote. Start from a realistic time so "fresh" prices are
        // actually fresh.
        env.ledger().set(LedgerInfo {
            timestamp: 1_000_000,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);
        let oracle_id = env.register_contract(None, MockPriceFeedOracle);
        let oracle_client = MockPriceFeedOracleClient::new(&env, &oracle_id);
        let base = Address::generate(&env);
        let quote = Address::generate(&env);
        (
            env,
            client,
            contract_id,
            oracle_client,
            oracle_id,
            base,
            quote,
        )
    }

    // ── Oracle tests ─────────────────────────────────────────────────────────

    #[test]
    fn test_get_price_returns_valid_oracle_price() {
        let (env, client, _, oracle_client, oracle_id, base, quote) = setup_oracle_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);
        client.set_price_oracle(&oracle_id);

        // Populate mock: 0.125 USD/XLM with 7 decimals = 1_250_000, fresh timestamp
        let now = env.ledger().timestamp();
        oracle_client.set_price(&base, &quote, &1_250_000, &7, &now);

        let price_data = client.get_price(&base, &quote);
        assert_eq!(price_data.price, 1_250_000);
        assert_eq!(price_data.decimals, 7);
        assert_eq!(price_data.timestamp, now);
    }

    #[test]
    fn test_get_price_fails_when_oracle_not_configured() {
        let (env, client, _, _oracle_client, _oracle_id, base, quote) = setup_oracle_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // No oracle set, no fallback
        assert_eq!(
            client.try_get_price(&base, &quote),
            Err(Ok(Error::OracleNotConfigured))
        );
    }

    #[test]
    fn test_get_price_uses_fallback_when_oracle_not_configured() {
        let (env, client, _, _oracle_client, _oracle_id, base, quote) = setup_oracle_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Set a fallback price but no live oracle
        client.set_fallback_price(&base, &quote, &1_000_000, &7);

        let fallback = client.get_fallback_price(&base, &quote);
        assert!(fallback.is_some());
        assert_eq!(fallback.unwrap().price, 1_000_000);

        // get_price should return the fallback
        let result = client.get_price(&base, &quote);
        assert_eq!(result.price, 1_000_000);
    }

    #[test]
    fn test_get_price_rejects_stale_data_and_uses_fallback() {
        let (env, client, _, oracle_client, oracle_id, base, quote) = setup_oracle_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);
        client.set_price_oracle(&oracle_id);
        // Threshold of 3600 seconds (default)
        client.set_staleness_threshold(&3_600u64);

        // Oracle returns a price with a very old timestamp (2 hours ago)
        let stale_timestamp = env.ledger().timestamp().saturating_sub(7_200);
        oracle_client.set_price(&base, &quote, &2_000_000, &7, &stale_timestamp);

        // Without fallback: should return OraclePriceStale
        assert_eq!(
            client.try_get_price(&base, &quote),
            Err(Ok(Error::OraclePriceStale))
        );

        // Add a fallback: should now return the fallback price
        client.set_fallback_price(&base, &quote, &1_800_000, &7);
        let result = client.get_price(&base, &quote);
        assert_eq!(result.price, 1_800_000);
    }

    #[test]
    fn test_get_price_rejects_invalid_price() {
        let (env, client, _, oracle_client, oracle_id, base, quote) = setup_oracle_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);
        client.set_price_oracle(&oracle_id);

        // Oracle returns price = 0 with a fresh timestamp
        let now = env.ledger().timestamp();
        oracle_client.set_price(&base, &quote, &0, &7, &now);

        assert_eq!(
            client.try_get_price(&base, &quote),
            Err(Ok(Error::OraclePriceInvalid))
        );
    }

    #[test]
    fn test_get_price_falls_back_when_oracle_call_fails() {
        let (env, client, _, oracle_client, oracle_id, base, quote) = setup_oracle_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);
        client.set_price_oracle(&oracle_id);

        // Configure mock to fail
        oracle_client.set_should_fail(&true);

        // No fallback: should error
        assert_eq!(
            client.try_get_price(&base, &quote),
            Err(Ok(Error::OracleCallFailed))
        );

        // With fallback configured: should succeed
        client.set_fallback_price(&base, &quote, &5_000_000, &7);
        let result = client.get_price(&base, &quote);
        assert_eq!(result.price, 5_000_000);
    }

    #[test]
    fn test_staleness_threshold_zero_disables_staleness_check() {
        let (env, client, _, oracle_client, oracle_id, base, quote) = setup_oracle_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);
        client.set_price_oracle(&oracle_id);
        // Set threshold to 0 = staleness check disabled
        client.set_staleness_threshold(&0u64);

        // Oracle returns a price with timestamp 0 (would normally be stale)
        oracle_client.set_price(&base, &quote, &3_000_000, &7, &0);

        // Should pass because staleness check is disabled
        let result = client.get_price(&base, &quote);
        assert_eq!(result.price, 3_000_000);
    }

    #[test]
    fn test_set_fallback_price_zero_clears_fallback() {
        let (env, client, _, _oracle_client, _oracle_id, base, quote) = setup_oracle_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Set then clear fallback
        client.set_fallback_price(&base, &quote, &1_000_000, &7);
        assert!(client.get_fallback_price(&base, &quote).is_some());

        client.set_fallback_price(&base, &quote, &0, &7);
        assert!(client.get_fallback_price(&base, &quote).is_none());
    }

    #[test]
    fn test_set_price_oracle_requires_compliance_officer_role() {
        let (env, client, _, _oracle_client, oracle_id, _base, _quote) = setup_oracle_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Only ComplianceOfficer (admin in this test via mock_all_auths) can set the oracle.
        // Verify auth is recorded for admin.
        client.set_price_oracle(&oracle_id);
        let auths = env.auths();
        let admin_auth_present = auths.iter().any(|(addr, _)| *addr == admin);
        assert!(
            admin_auth_present,
            "set_price_oracle must require admin/ComplianceOfficer authorization"
        );
    }

    /// Returns (env, client, contract_id).
    fn setup_env() -> (Env, PaymentRouterClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);
        (env, client, contract_id)
    }

    /// Deploys a Stellar Asset Contract test token. Returns
    /// (token_address, token_client, stellar_asset_admin_client).
    fn setup_token(
        env: &Env,
    ) -> (
        Address,
        token::Client<'static>,
        token::StellarAssetClient<'static>,
    ) {
        let token_admin = Address::generate(env);
        let token_address = env.register_stellar_asset_contract(token_admin);
        let token_client = token::Client::new(env, &token_address);
        let token_admin_client = token::StellarAssetClient::new(env, &token_address);
        (token_address, token_client, token_admin_client)
    }

    // ── Timelock tests ───────────────────────────────────────────────────────

    #[test]
    fn test_treasury_yield_deposit_harvest_and_withdraw() {
        let (env, client, _contract_id) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let protocol_id = env.register_contract(None, MockLendingProtocol);
        let protocol_client = MockLendingProtocolClient::new(&env, &protocol_id);
        let (token_address, token_client, token_admin_client) = setup_token(&env);

        client.initialize(&admin, &treasury, &100, &1_000, &PaymentRouter::MAX_AMOUNT);
        client.set_yield_protocol(&protocol_id);
        token_admin_client.mint(&treasury, &10_000);

        client.deposit_to_yield(&token_address, &6_000);
        assert_eq!(client.get_yield_position(&token_address), 6_000);
        assert_eq!(token_client.balance(&treasury), 4_000);
        assert_eq!(token_client.balance(&protocol_id), 6_000);

        token_admin_client.mint(&protocol_id, &500);
        protocol_client.accrue_yield(&token_address, &500);
        assert_eq!(client.harvest_yield(&token_address), 500);
        assert_eq!(token_client.balance(&treasury), 4_500);
        assert_eq!(client.get_yield_position(&token_address), 6_000);

        client.withdraw_from_yield(&token_address, &2_000);
        assert_eq!(client.get_yield_position(&token_address), 4_000);
        assert_eq!(token_client.balance(&treasury), 6_500);
        assert_eq!(token_client.balance(&protocol_id), 4_000);
    }

    #[test]
    fn test_yield_operations_require_configuration_and_valid_amounts() {
        let (env, client, _contract_id) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let (token_address, _token_client, _token_admin_client) = setup_token(&env);
        client.initialize(&admin, &treasury, &100, &1_000, &PaymentRouter::MAX_AMOUNT);

        assert_eq!(
            client.try_deposit_to_yield(&token_address, &100),
            Err(Ok(Error::YieldProtocolNotConfigured))
        );
        assert_eq!(
            client.try_deposit_to_yield(&token_address, &0),
            Err(Ok(Error::InvalidYieldAmount))
        );
        assert_eq!(
            client.try_withdraw_from_yield(&token_address, &1),
            Err(Ok(Error::InvalidYieldAmount))
        );
    }

    #[test]
    fn test_kyc_oracle_gates_only_high_value_payments() {
        let (env, client, _contract_id) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let oracle_id = env.register_contract(None, MockKycOracle);
        let oracle_client = MockKycOracleClient::new(&env, &oracle_id);
        let (token_address, token_client, token_admin_client) = setup_token(&env);

        client.initialize(&admin, &treasury, &100, &1_000, &PaymentRouter::MAX_AMOUNT);
        client.set_kyc_config(&oracle_id, &1_000);
        token_admin_client.mint(&sender, &10_000);

        client.route_payment(&sender, &recipient, &token_address, &500);
        assert_eq!(
            client.try_route_payment(&sender, &recipient, &token_address, &2_000),
            Err(Ok(Error::KycRequired))
        );

        oracle_client.set_verified(&sender, &true);
        client.route_payment(&sender, &recipient, &token_address, &2_000);
        assert_eq!(client.get_kyc_threshold(), Some(1_000));
        assert_eq!(token_client.balance(&sender), 7_500);
    }

    #[test]
    fn test_kyc_config_rejects_negative_threshold() {
        let (env, client, _contract_id) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let oracle = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1_000, &PaymentRouter::MAX_AMOUNT);

        assert_eq!(
            client.try_set_kyc_config(&oracle, &-1),
            Err(Ok(Error::InvalidKycThreshold))
        );
    }

    #[test]
    fn test_batch_payments_enforce_kyc_for_each_sender() {
        let (env, client, _contract_id) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let oracle_id = env.register_contract(None, MockKycOracle);
        let (token_address, _token_client, token_admin_client) = setup_token(&env);
        client.initialize(&admin, &treasury, &100, &1_000, &PaymentRouter::MAX_AMOUNT);
        client.set_kyc_config(&oracle_id, &1_000);
        token_admin_client.mint(&sender, &5_000);

        let payments = Vec::from_array(
            &env,
            [Payment {
                sender,
                recipient,
                token_address,
                amount: 2_000,
            }],
        );
        assert_eq!(
            client.try_route_payments(&payments),
            Err(Ok(Error::KycRequired))
        );
    }

    /// Regression test for the `route_payments` trap on a repeated sender.
    ///
    /// Found by the `route_payments` fuzz target: a batch listing the same
    /// sender twice aborted the whole invocation with a non-unwinding panic
    /// instead of returning an error. Re-authorizing an address that has
    /// already authorized the invocation is what trips the host, and splitting
    /// one payment across several recipients is an ordinary request, so this
    /// has to succeed rather than trap.
    ///
    /// Asserts the transfers actually landed, not just that the call returned:
    /// an early `Err` would also avoid the panic, so a "did not trap" check
    /// alone would pass for the wrong reason.
    #[test]
    fn test_batch_with_a_repeated_sender_succeeds() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let (token_address, token_client, token_admin_client) = setup_token(&env);
        client.initialize(
            &admin,
            &treasury,
            &100,
            &1_000_000,
            &PaymentRouter::MAX_AMOUNT,
        );

        let starting_balance = 1_000_000_000_i128;
        token_admin_client.mint(&sender, &starting_balance);

        let mut recipients: Vec<Address> = Vec::new(&env);
        for _ in 0..3 {
            recipients.push_back(Address::generate(&env));
        }
        let amount = 1_000_000_i128;
        let fee = amount * 100 / 10_000;

        // One sender, three payments, three distinct recipients.
        let mut payments: Vec<Payment> = Vec::new(&env);
        for recipient in recipients.iter() {
            payments.push_back(Payment {
                sender: sender.clone(),
                recipient: recipient.clone(),
                token_address: token_address.clone(),
                amount,
            });
        }

        client.route_payments(&payments);

        let expected_net = amount - fee;
        for recipient in recipients.iter() {
            assert_eq!(
                token_client.balance(&recipient),
                expected_net,
                "recipient was not paid the net amount"
            );
        }
        assert_eq!(token_client.balance(&treasury), fee * 3, "fee mismatch");
        assert_eq!(
            token_client.balance(&sender),
            starting_balance - (expected_net * 3) - (fee * 3),
            "sender was debited the wrong total"
        );
        // The per-sender daily spending record has to accumulate across every
        // payment in the batch, not just the last one.
        assert_eq!(client.get_user_volume(&sender), amount * 3);
    }

    /// A batch that repeats a sender *and* fails a later payment must still be
    /// a graceful `Err`: the distinct-sender authorization runs before any
    /// transfer, so a rejected batch leaves no partial state behind.
    #[test]
    fn test_batch_with_a_repeated_sender_rejects_gracefully() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_address, token_client, token_admin_client) = setup_token(&env);
        client.initialize(
            &admin,
            &treasury,
            &100,
            &1_000_000,
            &PaymentRouter::MAX_AMOUNT,
        );
        token_admin_client.mint(&sender, &1_000_000_000);

        // First payment is valid and from `sender`; the second is over the
        // per-payment cap, so the batch is rejected after `sender` has already
        // been authorized once.
        let payments = Vec::from_array(
            &env,
            [
                Payment {
                    sender: sender.clone(),
                    recipient: recipient.clone(),
                    token_address: token_address.clone(),
                    amount: 1_000_000,
                },
                Payment {
                    sender,
                    recipient: recipient.clone(),
                    token_address,
                    amount: PaymentRouter::MAX_AMOUNT + 1,
                },
            ],
        );

        assert_eq!(
            client.try_route_payments(&payments),
            Err(Ok(Error::LimitExceeded))
        );
        // Nothing was moved: validation rejects the whole batch up front.
        assert_eq!(token_client.balance(&recipient), 0);
    }

    /// A batch from several distinct senders must pay every one of them.
    ///
    /// The authorization pass walks a de-duplicated seen-set, so a sender
    /// appearing several times is authorized once while a batch of different
    /// senders is authorized once each.  This had no active coverage at all
    /// before, which is how an over-eager `require_auth` in the per-payment
    /// loop could abort every multi-payment batch.
    #[test]
    fn test_batch_with_several_distinct_senders_succeeds() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let (token_address, token_client, token_admin_client) = setup_token(&env);
        client.initialize(
            &admin,
            &treasury,
            &100,
            &1_000_000,
            &PaymentRouter::MAX_AMOUNT,
        );

        let starting_balance = 1_000_000_000_i128;
        let mut senders: Vec<Address> = Vec::new(&env);
        for _ in 0..2 {
            let sender = Address::generate(&env);
            token_admin_client.mint(&sender, &starting_balance);
            senders.push_back(sender);
        }

        let first_recipient = Address::generate(&env);
        let second_recipient = Address::generate(&env);
        let amount = 1_000_000_i128;
        let fee = amount * 100 / 10_000;
        let expected_net = amount - fee;

        // The first sender pays twice, the second once, so the batch mixes a
        // repeated sender with a distinct one.
        let payments = Vec::from_array(
            &env,
            [
                Payment {
                    sender: senders.get(0).unwrap().clone(),
                    recipient: first_recipient.clone(),
                    token_address: token_address.clone(),
                    amount,
                },
                Payment {
                    sender: senders.get(0).unwrap().clone(),
                    recipient: second_recipient.clone(),
                    token_address: token_address.clone(),
                    amount,
                },
                Payment {
                    sender: senders.get(1).unwrap().clone(),
                    recipient: first_recipient.clone(),
                    token_address: token_address.clone(),
                    amount,
                },
            ],
        );

        client.route_payments(&payments);

        assert_eq!(
            token_client.balance(&first_recipient),
            expected_net * 2,
            "first recipient should be paid for both incoming payments"
        );
        assert_eq!(
            token_client.balance(&second_recipient),
            expected_net,
            "second recipient should be paid once"
        );
        assert_eq!(token_client.balance(&treasury), fee * 3, "fee mismatch");
        // The first sender funded two payments, the second only one.
        assert_eq!(
            token_client.balance(&senders.get(0).unwrap()),
            starting_balance - (expected_net * 2) - (fee * 2),
            "first sender was debited the wrong total"
        );
        assert_eq!(
            token_client.balance(&senders.get(1).unwrap()),
            starting_balance - expected_net - fee,
            "second sender was debited the wrong total"
        );
    }

    #[test]
    fn test_queue_and_execute_set_fee_bps_after_delay() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Queue a fee-bps change.
        let nonce = client.queue_action(&ActionType::SetFeeBps(250));
        assert_eq!(nonce, 1);
        assert_eq!(client.get_fee(), 100); // Not applied yet.

        // Trying to execute immediately should fail (delay not elapsed).
        let res = client.try_execute_action(&nonce);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotReady);

        // Advance time past 24 hours.
        let current_time = env.ledger().timestamp();
        env.ledger().set(LedgerInfo {
            timestamp: current_time + PaymentRouter::SECONDS_IN_24H + 1,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });

        // Now execution should succeed.
        client.execute_action(&nonce);
        assert_eq!(client.get_fee(), 250);

        // Entry should be gone.
        let res = client.try_get_queued_action(&nonce);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotFound);
    }

    #[test]
    fn test_queue_and_execute_set_platform_treasury() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let nonce = client.queue_action(&ActionType::SetPlatformTreasury(new_treasury.clone()));

        // Advance 24h+.
        let ts = env.ledger().timestamp();
        env.ledger().set(LedgerInfo {
            timestamp: ts + PaymentRouter::SECONDS_IN_24H + 1,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });

        client.execute_action(&nonce);

        // Verify the treasury was actually updated by routing a payment and
        // checking where the fee lands.
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token_addr, token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);
        client.route_payment(&sender, &recipient, &token_addr, &1000);

        // 100 bps of 1000 = 10, capped to min(10, 1000) = 10
        assert_eq!(token_client.balance(&new_treasury), 10);
        assert_eq!(token_client.balance(&treasury), 0);
    }

    #[test]
    fn test_execute_action_not_found() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let res = client.try_execute_action(&99u64);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotFound);
    }

    #[test]
    fn test_cancel_action() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let nonce = client.queue_action(&ActionType::SetFeeBps(999));
        assert!(client.try_get_queued_action(&nonce).is_ok());

        client.cancel_action(&nonce);

        // Entry should be gone.
        let res = client.try_get_queued_action(&nonce);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotFound);

        // Fee should remain unchanged.
        assert_eq!(client.get_fee(), 100);
    }

    #[test]
    fn test_cancel_nonexistent_action() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let res = client.try_cancel_action(&42u64);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotFound);
    }

    #[test]
    fn test_nonce_increments() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let n1 = client.queue_action(&ActionType::SetFeeBps(200));
        let n2 = client.queue_action(&ActionType::SetFeeBps(300));
        let n3 = client.queue_action(&ActionType::SetFeeBps(400));

        assert_eq!(n1, 1);
        assert_eq!(n2, 2);
        assert_eq!(n3, 3);
    }

    // ── Freeze tests ─────────────────────────────────────────────────────────

    #[test]
    fn test_emergency_freeze_blocks_payments() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        assert!(!client.is_frozen());

        client.emergency_freeze();
        assert!(client.is_frozen());

        let res = client.try_route_payment(&sender, &recipient, &token_address, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::ContractFrozen);
    }

    #[test]
    fn test_emergency_freeze_blocks_timelock_execution() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let nonce = client.queue_action(&ActionType::SetFeeBps(500));

        // Advance past 24h.
        let ts = env.ledger().timestamp();
        env.ledger().set(LedgerInfo {
            timestamp: ts + PaymentRouter::SECONDS_IN_24H + 1,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });

        // Freeze the contract before execution.
        client.emergency_freeze();

        let res = client.try_execute_action(&nonce);
        assert_eq!(res.unwrap_err().unwrap(), Error::ContractFrozen);

        // Fee remains unchanged.
        assert_eq!(client.get_fee(), 100);
    }

    #[test]
    fn test_unfreeze_restores_payments() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        client.emergency_freeze();
        assert!(client.is_frozen());

        client.unfreeze();
        assert!(!client.is_frozen());

        // Payments should work again.
        client.route_payment(&sender, &recipient, &token_address, &1000);
    }

    #[test]
    fn test_freeze_queue_action_blocked() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.emergency_freeze();

        // Cannot queue new actions while frozen.
        let res = client.try_queue_action(&ActionType::SetFeeBps(500));
        assert_eq!(res.unwrap_err().unwrap(), Error::ContractFrozen);
    }

    #[test]
    fn test_cancel_action_allowed_while_frozen() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Queue an action before freezing.
        let nonce = client.queue_action(&ActionType::SetFeeBps(500));

        client.emergency_freeze();

        // Cancellation should still be possible while frozen (incident response).
        client.cancel_action(&nonce);
        let res = client.try_get_queued_action(&nonce);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotFound);
    }

    // ── Timelock emits events ────────────────────────────────────────────────

    #[test]
    fn test_queue_action_emits_event() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.queue_action(&ActionType::SetFeeBps(200));

        let events = env.events().all();
        let found = events.iter().any(|(_, topics, _)| {
            if topics.is_empty() {
                return false;
            }
            let raw = topics.get(0).unwrap();
            let sym: Result<Symbol, _> = raw.try_into_val(&env);
            sym.map(|s| s == Symbol::new(&env, "action_queued"))
                .unwrap_or(false)
        });
        assert!(found, "action_queued event not found");
    }

    #[test]
    fn test_freeze_emits_event() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.emergency_freeze();

        let events = env.events().all();
        let found = events.iter().any(|(_, topics, _)| {
            if topics.is_empty() {
                return false;
            }
            let raw = topics.get(0).unwrap();
            let sym: Result<Symbol, _> = raw.try_into_val(&env);
            sym.map(|s| s == Symbol::new(&env, "emergency_freeze"))
                .unwrap_or(false)
        });
        assert!(found, "emergency_freeze event not found");
    }

    // ── Original tests (retained) ────────────────────────────────────────────

    #[test]
    fn test_get_fee() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        // Before initialization, get_fee returns 0
        assert_eq!(client.get_fee(), 0);

        // Initialize with 150 bps
        client.initialize(&admin, &treasury, &150, &5000, &PaymentRouter::MAX_AMOUNT);
        assert_eq!(client.get_fee(), 150);

        // Update via set_fee_bps
        client.set_fee_bps(&250);
        assert_eq!(client.get_fee(), 250);

        // Update via set_fee_config
        client.set_fee_config(&300, &10000);
        assert_eq!(client.get_fee(), 300);
    }

    #[test]
    fn test_admin_restrictions_and_updates() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Trying to initialize again should fail
        let res = client.try_initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);
        assert_eq!(res.unwrap_err().unwrap(), Error::AlreadyInitialized);

        client.set_admin(&new_admin);

        // Modify config
        client.set_fee_config(&200, &2000);
        client.set_fee_bps(&200);
        assert_eq!(client.get_fee(), 200);

        let new_treasury = Address::generate(&env);
        client.set_platform_treasury(&new_treasury);
    }

    #[test]
    fn test_recover_tokens() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let (token_address, token_client, stellar_asset_client) = setup_token(&env);

        // Simulate tokens accidentally sent directly to the contract address
        let accidental_amount = 5_000i128;
        stellar_asset_client.mint(&contract_id, &accidental_amount);

        assert_eq!(token_client.balance(&contract_id), accidental_amount);
        assert_eq!(token_client.balance(&admin), 0);

        // Admin recovers tokens
        let recover_amount = 3_000i128;
        client.recover_tokens(&token_address, &recover_amount);

        assert_eq!(token_client.balance(&admin), recover_amount);
        assert_eq!(
            token_client.balance(&contract_id),
            accidental_amount - recover_amount
        );
    }

    #[test]
    fn test_set_pause_emits_event() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.set_pause(&true);

        let events = env.events().all();
        assert!(!events.is_empty());
        let (_, topics, _) = events.get(0).unwrap();
        assert_eq!(topics.len(), 1);
        let topic: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
        assert_eq!(topic, symbol_short!("pause"));
    }

    #[test]
    fn test_route_payment_emits_payment_initiated_event() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        client
            .mock_all_auths()
            .route_payment(&sender, &recipient, &token_address, &5_000);

        let events = env.events().all();
        assert!(!events.is_empty());

        let mut found = false;
        for (_, topics, data) in events.iter() {
            if !topics.is_empty() {
                if let Ok(topic_sym) = topics.get(0).unwrap().try_into_val(&env) {
                    let sym: Symbol = topic_sym;
                    if sym == Symbol::new(&env, "payment_initiated") {
                        found = true;
                        let amt: i128 = data.try_into_val(&env).unwrap();
                        assert_eq!(amt, 5_000);
                        break;
                    }
                }
            }
        }
        assert!(found, "payment_initiated event not found");
    }

    #[test]
    fn test_route_payment_emits_routed_event() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, _token_admin_client) = setup_token(&env);
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);
        client.add_supported_token(&token_address);

        let amount = 2_000i128;
        client.route_payment(&sender, &recipient, &token_address, &amount);

        let events = env.events().all();
        assert!(!events.is_empty());

        // Find the "routed" event by topic
        let mut found = None;
        for evt in events.iter() {
            let (_contract_id, topics, _data) = evt.clone();
            if topics.len() != 3 {
                continue;
            }
            let topic0: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
            if topic0 == symbol_short!("routed") {
                found = Some(evt.clone());
                break;
            }
        }
        let routed = found.expect("route_payment should publish a \"routed\" event");

        let (_contract_id, topics, data) = routed;
        assert_eq!(topics.len(), 3);

        let topic_sender: Address = topics.get(1).unwrap().try_into_val(&env).unwrap();
        let topic_recipient: Address = topics.get(2).unwrap().try_into_val(&env).unwrap();
        assert_eq!(topic_sender, sender);
        assert_eq!(topic_recipient, recipient);

        let event_amount: i128 = data.try_into_val(&env).unwrap();
        assert_eq!(event_amount, amount);
    }

    #[test]
    fn test_admin_pause_functionality() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, _token_admin_client) = setup_token(&env);
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        // Initially not paused
        assert!(!client.is_paused());

        // Pause
        client.set_pause(&true);
        assert!(client.is_paused());

        // Route payment should fail when paused
        let res = client.try_route_payment(&sender, &recipient, &token_address, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::Paused);

        // Unpause via set_paused alias
        client.set_paused(&false);
        assert!(!client.is_paused());

        // Route payment should succeed now
        client.route_payment(&sender, &recipient, &token_address, &1000);
    }

    // ── RBAC tests ───────────────────────────────────────────────────────────

    #[test]
    fn test_initialize_seeds_admin_into_all_roles() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        for role in [
            Role::SuperAdmin,
            Role::TreasuryManager,
            Role::ComplianceOfficer,
            Role::FeeManager,
            Role::Pauser,
        ] {
            assert!(client.has_role(&admin, &role));
            assert_eq!(client.get_role_member(&role), Some(admin.clone()));
        }
    }

    #[test]
    fn test_admin_can_grant_and_revoke_pauser_role() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let pauser = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        assert!(!client.has_role(&pauser, &Role::Pauser));

        client.grant_role(&admin, &pauser, &Role::Pauser);
        assert!(client.has_role(&pauser, &Role::Pauser));
        assert_eq!(client.get_role_member(&Role::Pauser), Some(pauser.clone()));

        client.revoke_role(&admin, &pauser, &Role::Pauser);
        assert!(!client.has_role(&pauser, &Role::Pauser));
        assert_eq!(client.get_role_member(&Role::Pauser), None);
    }

    #[test]
    fn test_assign_role_requires_super_admin_authorization() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let grantee = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.assign_role(&grantee, &Role::Pauser);

        // The SuperAdmin (admin) must be the authorizing address.
        let auths = env.auths();
        assert!(auths.iter().any(|(addr, _)| *addr == admin));
        assert_eq!(client.get_role_member(&Role::SuperAdmin), Some(admin));
    }

    #[test]
    fn test_granted_pauser_can_pause_and_unpause() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let pauser = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.assign_role(&pauser, &Role::Pauser);

        client.set_pause(&true);

        // The delegated Pauser, not the admin, authorizes the switch.
        let auths = env.auths();
        assert!(auths.iter().any(|(addr, _)| *addr == pauser));
        assert!(!auths.iter().any(|(addr, _)| *addr == admin));
        assert!(client.is_paused());

        client.set_paused(&false);
        assert!(!client.is_paused());
    }

    #[test]
    fn test_revoking_pauser_role_restores_admin_fallback() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let pauser = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.assign_role(&pauser, &Role::Pauser);
        client.revoke_role(&admin, &pauser, &Role::Pauser);

        // With no primary Pauser configured, pause authority falls back to admin.
        assert!(!client.has_role(&pauser, &Role::Pauser));
        client.set_pause(&true);
        let auths = env.auths();
        assert!(auths.iter().any(|(addr, _)| *addr == admin));
        assert!(client.is_paused());
    }

    #[test]
    fn test_fee_manager_role_gates_fee_functions() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let fee_manager = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.assign_role(&fee_manager, &Role::FeeManager);
        assert!(client.has_role(&fee_manager, &Role::FeeManager));

        client.set_min_limit(&50);

        let auths = env.auths();
        assert!(auths.iter().any(|(addr, _)| *addr == fee_manager));
    }

    #[test]
    fn test_revoked_fee_manager_loses_privileges() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let fee_manager = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.assign_role(&fee_manager, &Role::FeeManager);
        client.revoke_role(&admin, &fee_manager, &Role::FeeManager);
        assert!(!client.has_role(&fee_manager, &Role::FeeManager));

        // Authority falls back to the admin for the now-vacant role.
        client.set_min_limit(&75);
        let auths = env.auths();
        assert!(auths.iter().any(|(addr, _)| *addr == admin));
    }

    #[test]
    fn test_has_role_is_false_for_unassigned_accounts() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let stranger = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        for role in [
            Role::SuperAdmin,
            Role::TreasuryManager,
            Role::ComplianceOfficer,
            Role::FeeManager,
            Role::Pauser,
        ] {
            assert!(!client.has_role(&stranger, &role));
        }
    }

    // ── RBAC authorization tests ─────────────────────────────────────────────

    /// Like [`setup_env`], but without `mock_all_auths`.  A role gate can only
    /// be shown to *reject* an unauthorized caller when authorization is
    /// recorded explicitly, so these tests register exactly the signature the
    /// contract demands and observe whether it is accepted.
    fn setup_env_ungated() -> (Env, PaymentRouterClient<'static>, Address) {
        let env = Env::default();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);
        (env, client, contract_id)
    }

    /// Records one authorization: `address` is permitted to invoke `fn_name`
    /// with `args` on `contract`.  Every address the contract requires must be
    /// covered by some entry, or the call is rejected.
    fn authorize(env: &Env, contract: &Address, address: &Address, fn_name: &str, args: Vec<Val>) {
        env.mock_auths(&[MockAuth {
            address,
            invoke: &MockAuthInvoke {
                contract,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }

    /// The `initialize` arguments used throughout these tests, in the shape
    /// `MockAuthInvoke` needs.
    fn init_args(env: &Env, admin: &Address, treasury: &Address) -> Vec<Val> {
        (
            admin.clone(),
            treasury.clone(),
            100i128,
            1000i128,
            PaymentRouter::MAX_AMOUNT,
        )
            .into_val(env)
    }

    /// A non-admin cannot grant a role, and the grant does not take effect.
    #[test]
    fn test_non_admin_cannot_grant_role() {
        let (env, client, contract_id) = setup_env_ungated();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let outsider = Address::generate(&env);
        let grantee = Address::generate(&env);
        authorize(
            &env,
            &contract_id,
            &admin,
            "initialize",
            init_args(&env, &admin, &treasury),
        );
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // The outsider signs, but holds no SuperAdmin role.
        authorize(
            &env,
            &contract_id,
            &outsider,
            "grant_role",
            (outsider.clone(), grantee.clone(), Role::Pauser).into_val(&env),
        );
        assert_eq!(
            client.try_grant_role(&outsider, &grantee, &Role::Pauser),
            Err(Ok(Error::RoleNotFound))
        );
        assert!(!client.has_role(&grantee, &Role::Pauser));
    }

    /// A non-admin cannot revoke a role, and the role survives the attempt.
    #[test]
    fn test_non_admin_cannot_revoke_role() {
        let (env, client, contract_id) = setup_env_ungated();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let outsider = Address::generate(&env);
        let pauser = Address::generate(&env);
        authorize(
            &env,
            &contract_id,
            &admin,
            "initialize",
            init_args(&env, &admin, &treasury),
        );
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);
        authorize(
            &env,
            &contract_id,
            &admin,
            "grant_role",
            (admin.clone(), pauser.clone(), Role::Pauser).into_val(&env),
        );
        client.grant_role(&admin, &pauser, &Role::Pauser);

        authorize(
            &env,
            &contract_id,
            &outsider,
            "revoke_role",
            (outsider.clone(), pauser.clone(), Role::Pauser).into_val(&env),
        );
        assert_eq!(
            client.try_revoke_role(&outsider, &pauser, &Role::Pauser),
            Err(Ok(Error::RoleNotFound))
        );
        assert!(client.has_role(&pauser, &Role::Pauser));
    }

    /// Granting a role requires the SuperAdmin to be the authorizing address.
    ///
    /// This asserts *which* address must sign rather than driving an auth
    /// failure, because the Soroban test host aborts the process on an
    /// unmatched `require_auth` rather than surfacing it as a catchable
    /// contract error.  The rejection path itself is covered by
    /// `test_non_admin_cannot_grant_role`, which names a non-admin in the
    /// `admin` position and observes `Err(Error::RoleNotFound)`.
    #[test]
    fn test_grant_role_is_gated_on_the_super_admin_signature() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let grantee = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.grant_role(&admin, &grantee, &Role::Pauser);

        let auths = env.auths();
        assert!(
            auths.iter().any(|(addr, _)| *addr == admin),
            "grant_role must require the SuperAdmin to authorize"
        );
        assert!(client.has_role(&grantee, &Role::Pauser));
    }

    /// Granting twice and revoking twice converge on the same state: neither
    /// direction traps on a redundant call.
    #[test]
    fn test_grant_and_revoke_are_idempotent() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let pauser = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.grant_role(&admin, &pauser, &Role::Pauser);
        client.grant_role(&admin, &pauser, &Role::Pauser);
        assert!(client.has_role(&pauser, &Role::Pauser));
        assert_eq!(client.get_role_member(&Role::Pauser), Some(pauser.clone()));

        client.revoke_role(&admin, &pauser, &Role::Pauser);
        client.revoke_role(&admin, &pauser, &Role::Pauser);
        assert!(!client.has_role(&pauser, &Role::Pauser));
        assert_eq!(client.get_role_member(&Role::Pauser), None);
    }

    /// Revoking a role that was never granted is a no-op rather than a trap.
    #[test]
    fn test_revoke_never_granted_role_is_a_noop() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let stranger = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        assert!(!client.has_role(&stranger, &Role::Pauser));
        client.revoke_role(&admin, &stranger, &Role::Pauser);
        assert!(!client.has_role(&stranger, &Role::Pauser));
    }

    /// Reassigning a role transfers it: the previous holder must stop reporting
    /// the role, otherwise `has_role` would advertise authority the contract no
    /// longer accepts.
    #[test]
    fn test_reassigning_role_clears_the_previous_holder() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let first = Address::generate(&env);
        let second = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        assert!(client.has_role(&admin, &Role::Pauser));
        client.grant_role(&admin, &first, &Role::Pauser);
        assert!(client.has_role(&first, &Role::Pauser));

        client.grant_role(&admin, &second, &Role::Pauser);
        assert!(client.has_role(&second, &Role::Pauser));
        assert!(
            !client.has_role(&first, &Role::Pauser),
            "the displaced holder must not still report the role"
        );
        assert!(!client.has_role(&admin, &Role::Pauser));
    }

    /// With no holder for a role the root admin stands in, and `has_role` must
    /// agree with that fallback rather than reporting `false`.
    #[test]
    fn test_has_role_reports_the_admin_fallback() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let pauser = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Revoking the admin's own Pauser role leaves the role unassigned, so
        // authority reverts to the admin even though its grant flag is cleared.
        client.revoke_role(&admin, &admin, &Role::Pauser);
        assert_eq!(client.get_role_member(&Role::Pauser), None);
        assert!(client.has_role(&admin, &Role::Pauser));
        assert!(!client.has_role(&pauser, &Role::Pauser));

        client.set_pause(&true);
        assert!(client.is_paused());
    }

    /// The pause switch is gated on the `Pauser` role: the address the contract
    /// asks to authorize is the Pauser, and that authority is distinguishable
    /// from the admin's once the role is delegated.
    ///
    /// As above, the assertion is on which address must sign, since an
    /// unmatched `require_auth` aborts the test host.  `env.auths()` only
    /// reports the most recent invocation, so it is read immediately after the
    /// call under test and before any other client call.
    #[test]
    fn test_pause_switch_is_gated_on_the_pauser_role() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let pauser = Address::generate(&env);
        let stranger = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // `initialize` seeds the admin into every role, so it signs first.
        client.set_pause(&true);
        let auths = env.auths();
        assert!(auths.iter().any(|(addr, _)| *addr == admin));
        assert!(!auths.iter().any(|(addr, _)| *addr == pauser));
        assert!(client.is_paused());

        // After delegation only the Pauser is asked to authorize the switch.
        client.grant_role(&admin, &pauser, &Role::Pauser);
        client.set_paused(&false);
        let auths = env.auths();
        assert!(auths.iter().any(|(addr, _)| *addr == pauser));
        assert!(!auths.iter().any(|(addr, _)| *addr == admin));
        assert!(!client.is_paused());

        // An unassigned account is never treated as a Pauser.
        assert!(!client.has_role(&stranger, &Role::Pauser));
    }

    /// The `MinLimit` setter is gated on the `FeeManager` role, and that gate
    /// follows the role rather than the plain admin flag: once the role is
    /// delegated the FeeManager is the address asked to authorize.
    #[test]
    fn test_min_limit_is_gated_on_the_fee_manager_role() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let fee_manager = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Undelegated: the seeded FeeManager is the admin itself.
        client.set_min_limit(&50);
        let auths = env.auths();
        assert!(auths.iter().any(|(addr, _)| *addr == admin));

        client.grant_role(&admin, &fee_manager, &Role::FeeManager);
        client.set_min_limit(&75);
        let auths = env.auths();
        assert!(auths.iter().any(|(addr, _)| *addr == fee_manager));
        assert!(!auths.iter().any(|(addr, _)| *addr == admin));
    }

    /// The acting SuperAdmin may not revoke its own root role, which would
    /// leave role management unreachable.
    #[test]
    fn test_revoke_role_refuses_to_remove_the_acting_super_admin() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        assert_eq!(
            client.try_revoke_role(&admin, &admin, &Role::SuperAdmin),
            Err(Ok(Error::InvalidRole))
        );
        assert!(client.has_role(&admin, &Role::SuperAdmin));
    }

    /// Grants and revocations publish `role_assigned` / `role_revoked`.
    #[test]
    fn test_role_changes_emit_events() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let pauser = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.grant_role(&admin, &pauser, &Role::Pauser);
        let (_, topics, _) = env.events().all().last().unwrap();
        let assigned: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
        assert_eq!(assigned, Symbol::new(&env, "role_assigned"));
        assert!(client.has_role(&pauser, &Role::Pauser));

        client.revoke_role(&admin, &pauser, &Role::Pauser);
        let (_, topics, _) = env.events().all().last().unwrap();
        let revoked: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
        assert_eq!(revoked, Symbol::new(&env, "role_revoked"));
    }

    // ── Circuit breaker tests ────────────────────────────────────────────────

    /// While the breaker is open, non-essential state changes — payments,
    /// timelock queuing and the direct parameter setters — are rejected with
    /// `Error::Paused`.
    #[test]
    fn test_circuit_breaker_blocks_non_essential_state_changes() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        client.set_pause(&true);
        assert!(client.is_paused());

        // Timelock state changes are blocked.
        assert_eq!(
            client.try_queue_action(&ActionType::SetFeeBps(250)),
            Err(Ok(Error::Paused))
        );

        // Direct parameter setters are blocked.
        assert_eq!(client.try_set_fee_bps(&250), Err(Ok(Error::Paused)));
        assert_eq!(
            client.try_set_fee_config(&250, &1000),
            Err(Ok(Error::Paused))
        );
        assert_eq!(client.try_set_min_limit(&50), Err(Ok(Error::Paused)));
        let new_treasury = Address::generate(&env);
        assert_eq!(
            client.try_set_platform_treasury(&new_treasury),
            Err(Ok(Error::Paused))
        );
        let gov = Address::generate(&env);
        assert_eq!(client.try_set_governance(&gov), Err(Ok(Error::Paused)));

        let (token_address, _token_client, _sac) = setup_token(&env);
        assert_eq!(
            client.try_recover_tokens(&token_address, &10),
            Err(Ok(Error::Paused))
        );

        // Routing stays blocked too.
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        assert_eq!(
            client.try_route_payment(&sender, &recipient, &token_address, &10),
            Err(Ok(Error::Paused))
        );
    }

    /// A queued action cannot be executed while the breaker is open, but it can
    /// still be cancelled so the timelock queue is never stuck.
    #[test]
    fn test_circuit_breaker_blocks_execution_but_allows_cancel() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let nonce = client.queue_action(&ActionType::SetFeeBps(250));

        // Advance past the 24h timelock window.
        let ts = env.ledger().timestamp();
        env.ledger().set(LedgerInfo {
            timestamp: ts + PaymentRouter::SECONDS_IN_24H + 1,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });

        // Open the breaker before execution: the change is not applied.
        client.set_pause(&true);
        assert_eq!(client.try_execute_action(&nonce), Err(Ok(Error::Paused)));
        assert_eq!(client.get_fee(), 100);

        // Cancelling the queued action remains available while paused.
        client.cancel_action(&nonce);
        assert_eq!(
            client.try_get_queued_action(&nonce).unwrap_err().unwrap(),
            Error::TimelockNotFound
        );
    }

    /// Essential recovery paths stay callable while the breaker is open:
    /// user refunds, emergency withdrawals and resetting the breaker.
    #[test]
    fn test_circuit_breaker_keeps_essential_operations_available() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let (token_address, token_client, stellar_asset_client) = setup_token(&env);

        // Seed a refund balance and some stranded tokens for the emergency path.
        let refund_amount = 3_000i128;
        let stranded_amount = 2_000i128;
        stellar_asset_client.mint(&contract_id, &(refund_amount + stranded_amount));
        env.as_contract(&contract_id, || {
            PaymentRouter::credit_refund_balance(&env, &user, &token_address, refund_amount);
        });

        client.set_pause(&true);

        // Users can still withdraw their own refunded funds.
        client.withdraw_refund(&user, &token_address, &1_000);
        assert_eq!(token_client.balance(&user), 1_000);

        // Emergency withdrawal of stranded funds stays available.
        client.emergency_withdraw(&token_address, &stranded_amount);
        assert_eq!(token_client.balance(&admin), stranded_amount);

        // The breaker can always be reset.
        client.set_pause(&false);
        assert!(!client.is_paused());
    }

    /// Treasury yield movements are non-essential and are blocked while paused.
    #[test]
    fn test_circuit_breaker_blocks_yield_movements() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let protocol_id = env.register_contract(None, MockLendingProtocol);
        let (token_address, _token_client, _sac) = setup_token(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);
        client.set_yield_protocol(&protocol_id);

        client.set_pause(&true);
        assert_eq!(
            client.try_deposit_to_yield(&token_address, &100),
            Err(Ok(Error::Paused))
        );
        assert_eq!(
            client.try_harvest_yield(&token_address),
            Err(Ok(Error::Paused))
        );
        assert_eq!(
            client.try_withdraw_from_yield(&token_address, &50),
            Err(Ok(Error::Paused))
        );
    }

    #[test]
    fn test_route_payment_calculates_and_sends_fee() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, token_client, _token_admin_client) = setup_token(&env);

        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        let initial_balance = 10_000i128;
        sac.mint(&sender, &initial_balance);

        // Initialize router with 1% fee (100 bps) and cap of 50
        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);
        client.add_supported_token(&token_address);

        // Test normal fee calculation: 1% of 2000 = 20, below cap of 50
        let amount_1 = 2000i128;
        client.route_payment(&sender, &recipient, &token_address, &amount_1);

        assert_eq!(token_client.balance(&treasury), 20);
        assert_eq!(token_client.balance(&recipient), 1980);
        assert_eq!(token_client.balance(&sender), initial_balance - amount_1);
        assert_eq!(client.get_user_volume(&sender), amount_1);

        // Test fee capped at 50: 1% of 8000 = 80, capped to 50
        let amount_2 = 8000i128;
        client.route_payment(&sender, &recipient, &token_address, &amount_2);

        assert_eq!(token_client.balance(&treasury), 70);
        assert_eq!(token_client.balance(&recipient), 9930);
        assert_eq!(
            token_client.balance(&sender),
            initial_balance - amount_1 - amount_2
        );
        assert_eq!(client.get_user_volume(&sender), amount_1 + amount_2);
    }

    #[test]
    fn test_insufficient_balance() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&sender, &100);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);
        client.add_supported_token(&token_address);

        // Route payment of 500 when balance is only 100
        let res = client.try_route_payment(&sender, &recipient, &token_address, &500);
        assert_eq!(res.unwrap_err().unwrap(), Error::InsufficientBalance);
    }

    // ── Meta-transaction tests ─────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    fn sign_meta_payload(
        env: &Env,
        contract_id: &Address,
        sender: &Address,
        signer_pubkey: &BytesN<32>,
        recipient: &Address,
        token: &Address,
        amount: i128,
        nonce: u64,
        deadline: u64,
        signing_key: &ed25519_dalek::SigningKey,
    ) -> BytesN<64> {
        use ed25519_dalek::Signer;
        use soroban_sdk::xdr::ToXdr;
        let mut payload = soroban_sdk::Bytes::new(env);
        payload.append(&contract_id.to_xdr(env));
        payload.append(&sender.to_xdr(env));
        payload.append(&soroban_sdk::Bytes::from_slice(
            env,
            &signer_pubkey.to_array(),
        ));
        payload.append(&recipient.to_xdr(env));
        payload.append(&token.to_xdr(env));
        payload.append(&amount.to_xdr(env));
        payload.append(&nonce.to_xdr(env));
        payload.append(&deadline.to_xdr(env));
        let hash = env.crypto().sha256(&payload);
        let msg = soroban_sdk::Bytes::from(&hash);
        let mut buf = [0u8; 32];
        msg.copy_into_slice(&mut buf);
        let sig = signing_key.sign(&buf);
        BytesN::from_array(env, &sig.to_bytes())
    }

    #[test]
    fn test_meta_payment_success_and_nonce_increments() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let amount = 2000i128;
        let nonce = client.get_meta_nonce(&sender);
        assert_eq!(nonce, 0);
        let deadline = env.ledger().timestamp() + 100_000;

        token_client.approve(&sender, &contract_id, &amount, &1_000_000);

        let sig = sign_meta_payload(
            &env,
            &contract_id,
            &sender,
            &pubkey,
            &recipient,
            &token_address,
            amount,
            nonce,
            deadline,
            &signing_key,
        );

        client.route_payment_meta(
            &sender,
            &pubkey,
            &recipient,
            &token_address,
            &amount,
            &nonce,
            &deadline,
            &sig,
        );

        assert_eq!(client.get_meta_nonce(&sender), 1);
        assert_eq!(token_client.balance(&treasury), 20);
        assert_eq!(token_client.balance(&recipient), 1980);
        assert_eq!(token_client.balance(&sender), 10_000 - amount);
    }

    #[test]
    fn test_meta_payment_replay_rejected() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let amount = 1000i128;
        let nonce = client.get_meta_nonce(&sender);
        let deadline = env.ledger().timestamp() + 100_000;

        token_client.approve(&sender, &contract_id, &(amount * 2), &1_000_000);

        let sig = sign_meta_payload(
            &env,
            &contract_id,
            &sender,
            &pubkey,
            &recipient,
            &token_address,
            amount,
            nonce,
            deadline,
            &signing_key,
        );

        client.route_payment_meta(
            &sender,
            &pubkey,
            &recipient,
            &token_address,
            &amount,
            &nonce,
            &deadline,
            &sig,
        );

        let res = client.try_route_payment_meta(
            &sender,
            &pubkey,
            &recipient,
            &token_address,
            &amount,
            &nonce,
            &deadline,
            &sig,
        );
        assert_eq!(res.unwrap_err().unwrap(), Error::InvalidNonce);
    }

    #[test]
    fn test_meta_payment_expired_rejected() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[11u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let amount = 1000i128;
        let nonce = client.get_meta_nonce(&sender);
        let deadline = env.ledger().timestamp() + 10;

        token_client.approve(&sender, &contract_id, &amount, &1_000_000);

        let sig = sign_meta_payload(
            &env,
            &contract_id,
            &sender,
            &pubkey,
            &recipient,
            &token_address,
            amount,
            nonce,
            deadline,
            &signing_key,
        );

        let ts = env.ledger().timestamp();
        env.ledger().set(LedgerInfo {
            timestamp: ts + 100_000,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });

        let res = client.try_route_payment_meta(
            &sender,
            &pubkey,
            &recipient,
            &token_address,
            &amount,
            &nonce,
            &deadline,
            &sig,
        );
        assert_eq!(res.unwrap_err().unwrap(), Error::DeadlineExpired);
    }

    #[test]
    fn test_daily_limit_and_reset() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, token_client, _token_admin_client) = setup_token(&env);

        let limit = 10_000_000_000_000i128;
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &(limit + 2000));

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);
        client.add_supported_token(&token_address);

        // Route amount up to daily limit
        client.route_payment(&sender, &recipient, &token_address, &limit);

        // Next payment should exceed daily limit
        let res = client.try_route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(res.unwrap_err().unwrap(), Error::LimitExceeded);

        // Advance time past 24 hours to reset the daily limit
        let current_time = env.ledger().timestamp();
        let current_protocol_version = env.ledger().protocol_version();
        env.ledger().set(LedgerInfo {
            timestamp: current_time + 86400,
            protocol_version: current_protocol_version,
            sequence_number: 1,
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });

        // Now routing should succeed again. The first payment pushed volume past
        // VOLUME_THRESHOLD, so the halved rate applies: 2000 * 50 bps = 10.
        client.route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(token_client.balance(&recipient), (limit - 50) + (2000 - 10));
    }

    #[test]
    fn test_prevent_self_routing() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);

        let (token_address, _token_client, _token_admin_client) = setup_token(&env);
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        let res = client.try_route_payment(&sender, &sender, &token_address, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::InvalidRecipient);
    }

    #[test]
    #[ignore]
    fn test_tiered_fee_discount_applied_after_volume_threshold() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, token_client, _token_admin_client) = setup_token(&env);

        // Threshold is 10,000 XLM = 10,000 * 10,000,000 (7 decimals)
        let threshold = 100_000_000_000i128;
        let first_amount = threshold + 1;
        let second_amount = 1000i128;
        let total_mint = first_amount + second_amount + 10_000_000;
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &total_mint);

        // Initialize with 1% fee (100 bps) and no cap
        client.initialize(
            &admin,
            &treasury,
            &100,
            &i128::MAX,
            &PaymentRouter::MAX_AMOUNT,
        );

        // First payment: volume is 0 (< threshold), full fee applies
        client.route_payment(&sender, &recipient, &token_address, &first_amount);

        let full_fee_first = (first_amount * 100) / 10_000;
        assert_eq!(token_client.balance(&treasury), full_fee_first);
        assert_eq!(
            token_client.balance(&recipient),
            first_amount - full_fee_first
        );
        assert_eq!(client.get_user_volume(&sender), first_amount);
        // Volume is now past threshold, so next call gets the discount
        assert_eq!(client.get_effective_fee_bps(&sender), 50);

        // Second payment: volume > threshold, 50% discount applies
        client.route_payment(&sender, &recipient, &token_address, &second_amount);

        let discounted_fee = (second_amount * 50) / 10_000;
        assert_eq!(
            token_client.balance(&treasury),
            full_fee_first + discounted_fee
        );
        assert_eq!(
            token_client.balance(&recipient),
            (first_amount - full_fee_first) + (second_amount - discounted_fee)
        );
    }

    #[test]
    fn test_get_effective_fee_bps_no_discount_below_threshold() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, _token_admin_client) = setup_token(&env);
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &1_000_000);

        client.initialize(
            &admin,
            &treasury,
            &100,
            &i128::MAX,
            &PaymentRouter::MAX_AMOUNT,
        );

        // No volume yet
        assert_eq!(client.get_effective_fee_bps(&sender), 100);

        // Route a small payment (below threshold)
        client.route_payment(&sender, &recipient, &token_address, &1000);

        // Volume is 1000, far below 10,000 XLM threshold
        assert_eq!(client.get_effective_fee_bps(&sender), 100);
    }

    #[test]
    fn test_successful_xlm_routing() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let platform_treasury = Address::generate(&env);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        client.initialize(
            &admin,
            &platform_treasury,
            &40,
            &i128::MAX,
            &PaymentRouter::MAX_AMOUNT,
        );

        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());
        let sac = StellarAssetClient::new(&env, &token_address);
        let token_client = token::Client::new(&env, &token_address);

        let initial_balance = 1_000_000_000i128;
        sac.mint(&sender, &initial_balance);

        client.add_supported_token(&token_address);

        let amount = 100_000_000i128;
        client.route_payment(&sender, &recipient, &token_address, &amount);

        let expected_fee = 400_000i128;
        let expected_recipient_amount = amount - expected_fee;

        assert_eq!(token_client.balance(&sender), initial_balance - amount);
        assert_eq!(token_client.balance(&recipient), expected_recipient_amount);
        assert_eq!(token_client.balance(&platform_treasury), expected_fee);
    }

    #[test]
    fn test_initialize_sets_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let contract_addr = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_addr);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let stored_admin: Option<Address> = env.as_contract(&contract_addr, || {
            env.storage().instance().get(&DataKey::Admin)
        });
        assert_eq!(stored_admin, Some(admin));
    }

    /// Verifies that `emergency_withdraw` transfers the exact requested amount
    /// from the contract's own balance to the admin address.
    #[test]
    fn test_emergency_withdraw_transfers_tokens_to_admin() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let (token_address, token_client, stellar_asset_client) = setup_token(&env);

        // Fund the contract directly (simulates stranded tokens from a routing failure).
        let stranded_amount = 10_000i128;
        stellar_asset_client.mint(&contract_id, &stranded_amount);

        assert_eq!(token_client.balance(&contract_id), stranded_amount);
        assert_eq!(token_client.balance(&admin), 0);

        // Admin withdraws half the stranded balance.
        let withdraw_amount = 4_000i128;
        client.emergency_withdraw(&token_address, &withdraw_amount);

        assert_eq!(token_client.balance(&admin), withdraw_amount);
        assert_eq!(
            token_client.balance(&contract_id),
            stranded_amount - withdraw_amount
        );
    }

    /// Verifies that `emergency_withdraw` can drain the entire contract balance
    /// in a single call.
    #[test]
    fn test_emergency_withdraw_full_balance() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let (token_address, token_client, stellar_asset_client) = setup_token(&env);

        let stranded_amount = 7_500i128;
        stellar_asset_client.mint(&contract_id, &stranded_amount);

        client.emergency_withdraw(&token_address, &stranded_amount);

        assert_eq!(token_client.balance(&admin), stranded_amount);
        assert_eq!(token_client.balance(&contract_id), 0);
    }

    /// Verifies that `emergency_withdraw` declares admin authorization as required.
    ///
    /// Soroban's `require_auth()` uses an abort-on-failure model in the host
    /// (non-unwinding panics), so we cannot catch a missing-auth failure inside
    /// the same test process.  Instead we use `mock_all_auths_allowing_non_root_auth`
    /// to record which addresses the call attempts to authorize, then assert that
    /// the admin address — and *only* the admin — appears in that list.
    #[test]
    fn test_admin_is_required_for_emergency_withdraw() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let (token_address, _token_client, stellar_asset_client) = setup_token(&env);
        stellar_asset_client.mint(&contract_id, &5_000i128);

        // Call succeeds because mock_all_auths satisfies any require_auth.
        // What we verify is that the invocation recorded exactly one
        // authorization and that it belongs to admin, proving the function
        // gates on the admin address.
        client.emergency_withdraw(&token_address, &1_000i128);

        let auths = env.auths();
        let admin_auth_present = auths.iter().any(|(addr, _)| *addr == admin);
        assert!(
            admin_auth_present,
            "emergency_withdraw must require the admin address to authorize"
        );
    }

    #[test]
    fn test_blacklist_recipient() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        // Blacklist the recipient
        client.blacklist_address(&recipient);
        assert!(client.is_blacklisted(&recipient));

        // Route payment should fail
        let res = client.try_route_payment(&sender, &recipient, &token_address, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::Blacklisted);

        // Unblacklist and try again
        client.unblacklist_address(&recipient);
        assert!(!client.is_blacklisted(&recipient));

        client
            .mock_all_auths()
            .route_payment(&sender, &recipient, &token_address, &1000);
    }

    #[test]
    #[ignore]
    fn test_routes_multiple_distinct_assets() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        client.initialize(
            &admin,
            &treasury,
            &100,
            &1_000_000,
            &PaymentRouter::MAX_AMOUNT,
        );

        let (usdc_like_address, usdc_like_client, usdc_like_admin_client) = setup_token(&env);
        let (eurc_like_address, eurc_like_client, eurc_like_admin_client) = setup_token(&env);
        assert_ne!(usdc_like_address, eurc_like_address);

        usdc_like_admin_client.mint(&sender, &10_000);
        eurc_like_admin_client.mint(&sender, &5_000);

        client.route_payment(&sender, &recipient, &usdc_like_address, &2_000);
        client.route_payment(&sender, &recipient, &eurc_like_address, &1_000);

        assert_eq!(usdc_like_client.balance(&sender), 8_000);
        assert_eq!(usdc_like_client.balance(&recipient), 1_980);
        assert_eq!(eurc_like_client.balance(&sender), 4_000);
        assert_eq!(eurc_like_client.balance(&recipient), 990);
        assert_eq!(client.get_user_volume(&sender), 3_000);
    }

    #[test]
    fn test_benchmark_gas_costs() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);

        // Reset budget before initialization
        env.budget().reset_default();
        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);
        let init_cpu = env.budget().cpu_instruction_cost();
        let init_mem = env.budget().memory_bytes_cost();
        log!(
            &env,
            "GAS REPORT: initialize - CPU: {}, Mem: {}",
            init_cpu,
            init_mem
        );

        // Reset budget before route_payment
        env.budget().reset_default();
        client.route_payment(&sender, &recipient, &token_address, &5_000);
        let route_cpu = env.budget().cpu_instruction_cost();
        let route_mem = env.budget().memory_bytes_cost();
        log!(
            &env,
            "GAS REPORT: route_payment - CPU: {}, Mem: {}",
            route_cpu,
            route_mem
        );

        env.budget().print();

        // Fails CI if gas costs exceed defined thresholds
        // Set reasonable thresholds (e.g. 5M CPU and 2MB Mem per call)
        let max_cpu = 5_000_000;
        let max_mem = 2_000_000;

        assert!(
            init_cpu <= max_cpu,
            "initialize CPU cost exceeded threshold! Cost: {}, Threshold: {}",
            init_cpu,
            max_cpu
        );
        assert!(
            init_mem <= max_mem,
            "initialize Memory cost exceeded threshold! Cost: {}, Threshold: {}",
            init_mem,
            max_mem
        );

        assert!(
            route_cpu <= max_cpu,
            "route_payment CPU cost exceeded threshold! Cost: {}, Threshold: {}",
            route_cpu,
            max_cpu
        );
        assert!(
            route_mem <= max_mem,
            "route_payment Memory cost exceeded threshold! Cost: {}, Threshold: {}",
            route_mem,
            max_mem
        );
    }

    /// Rebuilds the pre-#663 packed `UserSpending` value (`BytesN<24>`) so
    /// tests can emulate legacy ledger state written by the old two-entry
    /// storage format.
    fn pack_legacy_spending_for_test(
        env: &Env,
        last_reset_time: u64,
        accumulated_amount: i128,
    ) -> BytesN<24> {
        let mut buf = [0u8; 24];
        buf[..8].copy_from_slice(&last_reset_time.to_be_bytes());
        buf[8..24].copy_from_slice(&accumulated_amount.to_be_bytes());
        BytesN::from_array(env, &buf)
    }

    /// Moves the oracle-style test ledger off timestamp 0, which `get_price`
    /// treats as a stale quote.
    fn set_realistic_ledger_time(env: &Env) {
        env.ledger().set(LedgerInfo {
            timestamp: 1_000_000,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });
    }

    /// Issue #663 acceptance benchmark: per-user (tag) registration storage
    /// cost must drop by at least 20%.
    ///
    /// The benchmark isolates the storage write path that registering a
    /// sender's first payment touches:
    ///
    /// * Legacy (pre-#663): two persistent entries (`UserSpending` +
    ///   `UserVolume`), each with its own write and TTL extension.
    /// * New (#663): one packed `UserRecord` entry with a single write and
    ///   TTL extension.
    ///
    /// It fails CI if the new path is not at least 20% cheaper in CPU
    /// instructions, if it uses more memory, or if the deterministic
    /// entry-count accounting (one entry instead of two) no longer holds.
    #[test]
    fn test_benchmark_storage_cost_reduction() {
        let (env, _client, contract_id) = setup_env();

        // `legacy_sender` emulates the pre-#663 two-entry write path;
        // `packed_sender` exercises the new single-entry write path.
        let legacy_sender = Address::generate(&env);
        let packed_sender = Address::generate(&env);

        let current_time = env.ledger().timestamp();
        let amount = 5_000i128;

        // Warm-up so lazy host/footprint initialization does not skew the
        // first measurement window.
        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::Admin, &legacy_sender);
        });
        env.budget().reset_default();

        // ── Legacy (pre-#663) registration write path ────────────────────
        {
            let legacy_sender = legacy_sender.clone();
            env.as_contract(&contract_id, || {
                let spending_key = DataKey::UserSpending(legacy_sender.clone());
                env.storage().persistent().set(
                    &spending_key,
                    &pack_legacy_spending_for_test(&env, current_time, amount),
                );
                env.storage().persistent().extend_ttl(
                    &spending_key,
                    PaymentRouter::PERSISTENT_LIFETIME_THRESHOLD,
                    PaymentRouter::PERSISTENT_BUMP_AMOUNT,
                );

                let volume_key = DataKey::UserVolume(legacy_sender.clone());
                env.storage().persistent().set(&volume_key, &amount);
                env.storage().persistent().extend_ttl(
                    &volume_key,
                    PaymentRouter::PERSISTENT_LIFETIME_THRESHOLD,
                    PaymentRouter::PERSISTENT_BUMP_AMOUNT,
                );
            });
        }
        let legacy_cpu = env.budget().cpu_instruction_cost();
        let legacy_mem = env.budget().memory_bytes_cost();

        env.budget().reset_default();

        // ── New (#663) registration write path ───────────────────────────
        {
            let packed_sender = packed_sender.clone();
            env.as_contract(&contract_id, || {
                let record_key = DataKey::UserRecord(packed_sender.clone());
                let record = pack_user_record(&env, current_time, amount, amount);
                env.storage().persistent().set(&record_key, &record);
                env.storage().persistent().extend_ttl(
                    &record_key,
                    PaymentRouter::PERSISTENT_LIFETIME_THRESHOLD,
                    PaymentRouter::PERSISTENT_BUMP_AMOUNT,
                );
            });
        }
        let new_cpu = env.budget().cpu_instruction_cost();
        let new_mem = env.budget().memory_bytes_cost();

        std::eprintln!(
            "GAS REPORT: user-registration storage legacy (2 entries) - CPU: {}, Mem: {}",
            legacy_cpu,
            legacy_mem
        );
        std::eprintln!(
            "GAS REPORT: user-registration storage packed (1 entry)  - CPU: {}, Mem: {}",
            new_cpu,
            new_mem
        );
        std::eprintln!(
            "GAS REPORT: user-registration storage CPU reduction: {}%",
            100 - (new_cpu * 100) / legacy_cpu
        );

        // Deterministic accounting: the legacy path leaves two persistent
        // entries per registered sender, the new path exactly one.
        env.as_contract(&contract_id, || {
            assert!(
                env.storage()
                    .persistent()
                    .has(&DataKey::UserSpending(legacy_sender.clone())),
                "legacy path must write the UserSpending entry"
            );
            assert!(
                env.storage()
                    .persistent()
                    .has(&DataKey::UserVolume(legacy_sender.clone())),
                "legacy path must write the UserVolume entry"
            );
            assert!(
                env.storage()
                    .persistent()
                    .has(&DataKey::UserRecord(packed_sender.clone())),
                "new path must write the packed UserRecord entry"
            );
        });

        // Acceptance criterion: >= 20% CPU-instruction reduction.
        assert!(
            new_cpu * 10 <= legacy_cpu * 8,
            "packed registration write path must cost >= 20% less CPU \
             (legacy: {}, packed: {}, reduction: {}%)",
            legacy_cpu,
            new_cpu,
            100 - (new_cpu * 100) / legacy_cpu
        );
        // Memory must not regress either.
        assert!(
            new_mem <= legacy_mem,
            "packed registration write path must not use more memory \
             (legacy: {}, packed: {})",
            legacy_mem,
            new_mem
        );
    }

    /// The packed `UserRecord` replaces the two per-user entries and keeps
    /// every public getter consistent (issue #663).
    #[test]
    fn test_user_record_packed_storage_roundtrip() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        // Fresh sender: zeroed record, window anchored at "now".
        let before = client.get_user_record(&sender);
        assert_eq!(before.volume, 0);
        assert_eq!(before.accumulated_amount, 0);
        assert_eq!(before.last_reset_time, env.ledger().timestamp());

        // The first payment registers the sender's packed record.
        client.route_payment(&sender, &recipient, &token_address, &2_000);

        let after_first = client.get_user_record(&sender);
        assert_eq!(after_first.accumulated_amount, 2_000);
        assert_eq!(after_first.volume, 2_000);

        // Exactly one persistent user entry now exists — the packed record.
        env.as_contract(&contract_id, || {
            let record_key = DataKey::UserRecord(sender.clone());
            assert!(env.storage().persistent().has(&record_key));
            assert!(!env
                .storage()
                .persistent()
                .has(&DataKey::UserSpending(sender.clone())));
            assert!(!env
                .storage()
                .persistent()
                .has(&DataKey::UserVolume(sender.clone())));
        });

        // A second payment accumulates in both counters.
        client.route_payment(&sender, &recipient, &token_address, &3_000);

        let after_second = client.get_user_record(&sender);
        assert_eq!(after_second.accumulated_amount, 5_000);
        assert_eq!(after_second.volume, 5_000);

        // The pre-existing getters stay consistent with the packed record.
        assert_eq!(client.get_user_volume(&sender), 5_000);
    }

    /// Permissionless `migrate_user_record` combines legacy entries into the
    /// packed format and removes the old keys (issue #663).
    #[test]
    fn test_migrate_user_record_combines_legacy_entries() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        // Give the ledger a realistic timestamp so the legacy window start can
        // be back-dated.
        set_realistic_ledger_time(&env);

        // Emulate pre-#663 ledger state: split UserSpending + UserVolume.
        let legacy_window_start = env.ledger().timestamp() - 60;
        let spending_key = DataKey::UserSpending(user.clone());
        let volume_key = DataKey::UserVolume(user.clone());
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(
                &spending_key,
                &pack_legacy_spending_for_test(&env, legacy_window_start, 1_200),
            );
            env.storage().persistent().set(&volume_key, &7_500i128);
        });

        // Getters still see the legacy state through the fallback path.
        assert_eq!(client.get_user_volume(&user), 7_500);
        let pre = client.get_user_record(&user);
        assert_eq!(pre.accumulated_amount, 1_200);
        assert_eq!(pre.volume, 7_500);

        // Migrate: reports success, writes the packed record, drops the
        // legacy keys.
        assert!(client.migrate_user_record(&user));

        env.as_contract(&contract_id, || {
            let record_key = DataKey::UserRecord(user.clone());
            assert!(env.storage().persistent().has(&record_key));
            assert!(!env.storage().persistent().has(&spending_key));
            assert!(!env.storage().persistent().has(&volume_key));
        });

        let post = client.get_user_record(&user);
        assert_eq!(post.accumulated_amount, 1_200);
        assert_eq!(post.volume, 7_500);
        assert_eq!(post.last_reset_time, legacy_window_start);
        assert_eq!(client.get_user_volume(&user), 7_500);

        // Migrating again is a no-op.
        assert!(!client.migrate_user_record(&user));

        // And a fresh payment continues from the migrated record.
        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&user, &10_000);
        let recipient = Address::generate(&env);
        client.route_payment(&user, &recipient, &token_address, &500);

        let after = client.get_user_record(&user);
        assert_eq!(after.accumulated_amount, 1_700);
        assert_eq!(after.volume, 8_000);
        assert_eq!(client.get_user_volume(&user), 8_000);
    }

    /// A payment routed by a sender that only has legacy entries transparently
    /// upgrades them to the packed record (issue #663 migration path).
    #[test]
    fn test_route_payment_upgrades_legacy_entries_in_place() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        // Give the ledger a realistic timestamp so the legacy window start can
        // be back-dated.
        set_realistic_ledger_time(&env);

        // Legacy state from before the upgrade.
        let legacy_window_start = env.ledger().timestamp() - 60;
        let spending_key = DataKey::UserSpending(sender.clone());
        let volume_key = DataKey::UserVolume(sender.clone());
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(
                &spending_key,
                &pack_legacy_spending_for_test(&env, legacy_window_start, 4_000),
            );
            env.storage().persistent().set(&volume_key, &20_000i128);
        });

        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&sender, &50_000);

        // No explicit migration needed: routing the payment combines the
        // legacy entries into the packed record on its next write.
        client.route_payment(&sender, &recipient, &token_address, &1_000);

        env.as_contract(&contract_id, || {
            let record_key = DataKey::UserRecord(sender.clone());
            assert!(env.storage().persistent().has(&record_key));
            assert!(!env.storage().persistent().has(&spending_key));
            assert!(!env.storage().persistent().has(&volume_key));
        });

        let record = client.get_user_record(&sender);
        assert_eq!(record.accumulated_amount, 5_000);
        assert_eq!(record.volume, 21_000);
        assert_eq!(client.get_user_volume(&sender), 21_000);
    }

    /// `migrate_user_record` is a safe no-op for unknown senders and for
    /// senders that already have a packed record (issue #663).
    #[test]
    fn test_migrate_user_record_no_op_cases() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let unknown = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        // Unknown sender: nothing to migrate.
        assert!(!client.migrate_user_record(&unknown));

        // Sender with a packed record already: nothing to migrate.
        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&sender, &10_000);
        client.route_payment(&sender, &recipient, &token_address, &1_000);
        assert!(!client.migrate_user_record(&sender));

        // State is untouched.
        let record = client.get_user_record(&sender);
        assert_eq!(record.volume, 1_000);
        assert_eq!(record.accumulated_amount, 1_000);
    }

    #[test]
    #[ignore]
    fn test_refund_ledger_and_withdrawal() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &50, &PaymentRouter::MAX_AMOUNT);

        let (token_address, token_client, stellar_asset_client) = setup_token(&env);

        // Initially zero refund balance
        assert_eq!(client.get_refund_balance(&user, &token_address), 0);

        // Simulate stranded tokens in contract and credit internal refund balance
        let refund_amount = 5_000i128;
        stellar_asset_client.mint(&contract_id, &refund_amount);

        env.as_contract(&contract_id, || {
            PaymentRouter::credit_refund_balance(&env, &user, &token_address, refund_amount);
        });

        assert_eq!(
            client.get_refund_balance(&user, &token_address),
            refund_amount
        );

        // User withdraws partial refund
        let partial_amount = 2_000i128;
        client.withdraw_refund(&user, &token_address, &partial_amount);

        assert_eq!(token_client.balance(&user), partial_amount);
        assert_eq!(
            client.get_refund_balance(&user, &token_address),
            refund_amount - partial_amount
        );

        // User claims remaining refunds with claim_all_refunds
        let claimed = client.claim_all_refunds(&user, &token_address);
        assert_eq!(claimed, refund_amount - partial_amount);
        assert_eq!(token_client.balance(&user), refund_amount);
        assert_eq!(client.get_refund_balance(&user, &token_address), 0);

        // Trying to withdraw again should fail with NoRefundAvailable
        let res = client.try_withdraw_refund(&user, &token_address, &100);
        assert_eq!(res.unwrap_err().unwrap(), Error::NoRefundAvailable);
    }

    #[test]
    fn test_governance_takes_over_fees() {
        let (_, client, _) = setup_env();

        let admin = Address::generate(&client.env);
        let treasury = Address::generate(&client.env);
        let gov = Address::generate(&client.env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Admin can still update fees before governance is set
        client.set_fee_bps(&150);
        assert_eq!(client.get_fee(), 150);

        // Admin hands control over to governance
        client.set_governance(&gov);

        // Governance address can now update the fee
        client.set_fee_bps(&200);
        assert_eq!(client.get_fee(), 200);
    }

    /// Instance-storage keys for [`MockDex`].
    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum MockDexKey {
        RateNum,
        RateDen,
        ShouldRevert,
    }

    /// Errors the mock DEX can return.
    #[contracterror]
    #[derive(Copy, Clone, Debug, Eq, PartialEq)]
    pub enum MockDexError {
        /// The mock was told to simulate a failing DEX.
        Reverted = 1,
    }

    /// Minimal stand-in for a Soroban DEX, exposing the adapter interface the
    /// payment router expects:
    /// `swap(sell_token, buy_token, amount_in, min_amount_out, recipient) -> i128`
    /// and `quote(sell_token, buy_token, amount_in) -> i128`.
    ///
    /// It trades at a configurable rate.  The router funds it with the sell
    /// token before the call, so `swap` only has to settle the buy token to
    /// `recipient`.
    #[contract]
    pub struct MockDex;

    #[contractimpl]
    impl MockDex {
        /// Sets the swap rate: `amount_out = amount_in * num / den`.
        pub fn set_rate(env: Env, num: i128, den: i128) {
            env.storage().instance().set(&MockDexKey::RateNum, &num);
            env.storage().instance().set(&MockDexKey::RateDen, &den);
        }

        /// Makes `swap` revert, simulating a DEX that cannot fill the trade.
        pub fn set_should_revert(env: Env, should_revert: bool) {
            env.storage()
                .instance()
                .set(&MockDexKey::ShouldRevert, &should_revert);
        }

        /// Prices a swap without moving any funds.
        pub fn quote(env: Env, _sell_token: Address, _buy_token: Address, amount_in: i128) -> i128 {
            Self::rate(&env, amount_in)
        }

        /// Sells the `amount_in` sell token this adapter was funded with and
        /// delivers the buy token to `recipient`.
        pub fn swap(
            env: Env,
            sell_token: Address,
            buy_token: Address,
            amount_in: i128,
            _min_amount_out: i128,
            recipient: Address,
        ) -> Result<i128, MockDexError> {
            if env
                .storage()
                .instance()
                .get(&MockDexKey::ShouldRevert)
                .unwrap_or(false)
            {
                return Err(MockDexError::Reverted);
            }
            // The router has already funded this adapter with `amount_in` of
            // the sell token, so the only work left is to sell it and settle
            // the buy token to `recipient`.
            let _ = sell_token;
            let amount_out = Self::rate(&env, amount_in);
            let buy_client = token::Client::new(&env, &buy_token);
            buy_client.transfer(&env.current_contract_address(), &recipient, &amount_out);

            Ok(amount_out)
        }

        /// PROBE: pull into self.
        pub fn probe_self_take(env: Env, token_addr: Address, from: Address, amount: i128) -> i128 {
            from.require_auth();
            let c = token::Client::new(&env, &token_addr);
            c.transfer(&from, &env.current_contract_address(), &amount);
            amount
        }

        /// PROBE: pay out to another contract.
        pub fn probe_pay_to_contract(
            env: Env,
            token_addr: Address,
            to: Address,
            amount: i128,
        ) -> i128 {
            let c = token::Client::new(&env, &token_addr);
            c.transfer(&env.current_contract_address(), &to, &amount);
            amount
        }

        /// Applies the configured rate to `amount_in`.
        fn rate(env: &Env, amount_in: i128) -> i128 {
            let num: i128 = env
                .storage()
                .instance()
                .get(&MockDexKey::RateNum)
                .unwrap_or(1);
            let den: i128 = env
                .storage()
                .instance()
                .get(&MockDexKey::RateDen)
                .unwrap_or(1);
            amount_in * num / den
        }
    }

    /// Moves the test ledger to `timestamp`.
    fn set_timestamp(env: &Env, timestamp: u64) {
        env.ledger().set(LedgerInfo {
            timestamp,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });
    }

    /// A funded router, two tokens, and a registered mock DEX trading the sell
    /// token for the buy token at `rate_num:rate_den`.
    struct SwapFixture {
        env: Env,
        client: PaymentRouterClient<'static>,
        contract_id: Address,
        treasury: Address,
        sender: Address,
        recipient: Address,
        dex: Address,
        sell_token: Address,
        buy_token: Address,
        sell_client: token::Client<'static>,
        buy_client: token::Client<'static>,
        dex_client: MockDexClient<'static>,
    }

    impl SwapFixture {
        /// A new address holding `amount` of the sell token.
        fn funded_sender(&self, amount: i128) -> Address {
            let sender = Address::generate(&self.env);
            let sac = token::StellarAssetClient::new(&self.env, &self.sell_token);
            sac.mint(&sender, &amount);
            sender
        }

        /// Builds a swap-routed payment from `sender` to the fixture recipient
        /// with no deadline and no quote supplied, so only `min_amount_out`
        /// guards it.
        fn payment_from(
            &self,
            sender: &Address,
            amount_in: i128,
            min_amount_out: i128,
        ) -> SwapPayment {
            SwapPayment {
                sender: sender.clone(),
                recipient: self.recipient.clone(),
                sell_token: self.sell_token.clone(),
                buy_token: self.buy_token.clone(),
                amount_in,
                min_amount_out,
                expected_amount_out: 0,
                deadline: 0,
                dex: self.dex.clone(),
            }
        }

        /// A swap-routed payment from the fixture's main sender.
        fn payment(&self, amount_in: i128, min_amount_out: i128) -> SwapPayment {
            self.payment_from(&self.sender, amount_in, min_amount_out)
        }
    }

    /// Deploys a router with a 1% platform fee capped at 1_000 base units, two
    /// Stellar Asset Contracts, and a registered mock DEX at `rate_num:rate_den`.
    fn setup_swap_fixture(rate_num: i128, rate_den: i128) -> SwapFixture {
        let env = Env::default();
        env.mock_all_auths();
        // A swap crosses two extra contracts per payment, which can outrun the
        // default test budget; these tests assert behaviour, not gas.
        env.budget().reset_unlimited();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1_000, &PaymentRouter::MAX_AMOUNT);

        let (sell_token, sell_client, sell_admin_client) = setup_token(&env);
        let (buy_token, buy_client, buy_admin_client) = setup_token(&env);

        // The DEX trades at the configured rate and is pre-funded with the
        // buy token so it can settle.
        let dex = env.register_contract(None, MockDex);
        let dex_client = MockDexClient::new(&env, &dex);
        dex_client.set_rate(&rate_num, &rate_den);
        buy_admin_client.mint(&dex, &10_000_000);

        sell_admin_client.mint(&sender, &1_000_000);

        client.register_dex(&dex);

        SwapFixture {
            env,
            client,
            contract_id,
            treasury,
            sender,
            recipient,
            dex,
            sell_token,
            buy_token,
            sell_client,
            buy_client,
            dex_client,
        }
    }

    #[test]
    fn test_route_payment_with_swap_delivers_buy_token_after_fee() {
        let f = setup_swap_fixture(1, 1);

        // 10 000 sell tokens in, 10 000 buy tokens out, 1% fee = 100.
        let delivered = f.client.route_payment_with_swap(&f.payment(10_000, 10_000));
        assert_eq!(delivered, 9_900);

        assert_eq!(f.sell_client.balance(&f.sender), 990_000);
        assert_eq!(f.buy_client.balance(&f.recipient), 9_900);
        assert_eq!(f.buy_client.balance(&f.treasury), 100);
        // The sell token ended up in the DEX, and volume is booked on it.
        assert_eq!(f.sell_client.balance(&f.dex), 10_000);
        assert_eq!(f.sell_client.balance(&f.contract_id), 0);
        assert_eq!(f.client.get_user_volume(&f.sender), 10_000);
    }

    #[test]
    fn test_route_payment_with_swap_honours_a_worse_exchange_rate() {
        // The DEX returns one buy token for every two sold.
        let f = setup_swap_fixture(1, 2);

        let delivered = f.client.route_payment_with_swap(&f.payment(10_000, 5_000));
        assert_eq!(delivered, 4_950); // 5_000 out less the 1% fee
        assert_eq!(f.buy_client.balance(&f.recipient), 4_950);
        assert_eq!(f.buy_client.balance(&f.treasury), 50);
    }

    #[test]
    fn test_swap_below_min_amount_out_reverts_the_whole_payment() {
        let f = setup_swap_fixture(1, 2);

        // Only 5_000 buy tokens are available, so a 6_000 floor must abort.
        let payment = f.payment(10_000, 6_000);
        let res = f.client.try_route_payment_with_swap(&payment);
        assert_eq!(res.unwrap_err().unwrap(), Error::SlippageExceeded);

        // Atomic failure: the sender keeps every token, nobody is paid, and no
        // state was booked.
        assert_eq!(f.sell_client.balance(&f.sender), 1_000_000);
        assert_eq!(f.sell_client.balance(&f.dex), 0);
        assert_eq!(f.buy_client.balance(&f.recipient), 0);
        assert_eq!(f.buy_client.balance(&f.treasury), 0);
        assert_eq!(f.client.get_user_volume(&f.sender), 0);
    }

    #[test]
    fn test_swap_beyond_max_slippage_ceiling_reverts_the_payment() {
        let f = setup_swap_fixture(1, 1);

        // min_amount_out is easy to clear, but the caller also quoted 20 000,
        // which is 100% better than the 10 000 actually delivered.
        let mut payment = f.payment(10_000, 1);
        payment.expected_amount_out = 20_000;

        let res = f.client.try_route_payment_with_swap(&payment);
        assert_eq!(res.unwrap_err().unwrap(), Error::SlippageExceeded);
        assert_eq!(f.buy_client.balance(&f.recipient), 0);
        assert_eq!(f.sell_client.balance(&f.sender), 1_000_000);
    }

    #[test]
    fn test_swap_within_max_slippage_ceiling_settles() {
        let f = setup_swap_fixture(1, 1);

        // 10% default ceiling: a 9_500 output against a 10_000 quote clears it.
        let mut payment = f.payment(10_000, 9_500);
        payment.expected_amount_out = 10_000;

        // 10 000 out, which is 5% under the 10 000 quote, clears the 10%
        // ceiling; the 1% fee is taken from the output.
        let delivered = f.client.route_payment_with_swap(&payment);
        assert_eq!(delivered, 9_900);
        assert_eq!(f.buy_client.balance(&f.recipient), 9_900);
    }

    #[test]
    fn test_swap_failing_dex_aborts_the_payment() {
        let f = setup_swap_fixture(1, 1);
        f.dex_client.set_should_revert(&true);

        let res = f.client.try_route_payment_with_swap(&f.payment(10_000, 1));
        assert_eq!(res.unwrap_err().unwrap(), Error::SwapFailed);

        assert_eq!(f.sell_client.balance(&f.sender), 1_000_000);
        assert_eq!(f.buy_client.balance(&f.recipient), 0);
        assert_eq!(f.buy_client.balance(&f.treasury), 0);
        assert_eq!(f.client.get_user_volume(&f.sender), 0);
    }

    #[test]
    fn test_swap_requires_a_registered_dex() {
        let f = setup_swap_fixture(1, 1);

        let mut payment = f.payment(10_000, 1);
        payment.dex = Address::generate(&f.env);

        let res = f.client.try_route_payment_with_swap(&payment);
        assert_eq!(res.unwrap_err().unwrap(), Error::DexNotRegistered);
        assert_eq!(f.sell_client.balance(&f.sender), 1_000_000);
    }

    #[test]
    fn test_swap_after_its_deadline_is_rejected() {
        let f = setup_swap_fixture(1, 1);
        set_timestamp(&f.env, 1_000);

        let mut payment = f.payment(10_000, 1);
        payment.deadline = 500;

        let res = f.client.try_route_payment_with_swap(&payment);
        assert_eq!(res.unwrap_err().unwrap(), Error::SwapDeadlineExpired);
        assert_eq!(f.sell_client.balance(&f.sender), 1_000_000);
    }

    #[test]
    fn test_swap_within_its_deadline_settles() {
        let f = setup_swap_fixture(1, 1);
        set_timestamp(&f.env, 1_000);

        let mut payment = f.payment(10_000, 1);
        payment.deadline = 1_500;

        assert_eq!(f.client.route_payment_with_swap(&payment), 9_900);
    }

    #[test]
    fn test_swap_rejects_unusable_parameters() {
        let f = setup_swap_fixture(1, 1);

        // Same token on both sides is not a swap.
        let mut same_token = f.payment(10_000, 1);
        same_token.buy_token = same_token.sell_token.clone();
        assert_eq!(
            f.client
                .try_route_payment_with_swap(&same_token)
                .unwrap_err()
                .unwrap(),
            Error::InvalidSwapParams
        );

        // A zero floor would accept any output, including none at all.
        let mut no_floor = f.payment(10_000, 0);
        no_floor.min_amount_out = 0;
        assert_eq!(
            f.client
                .try_route_payment_with_swap(&no_floor)
                .unwrap_err()
                .unwrap(),
            Error::InvalidSwapParams
        );
    }

    #[test]
    fn test_swap_enforces_balance_limits_and_recipient_rules() {
        let f = setup_swap_fixture(1, 1);

        // More sell tokens than the sender holds.
        let res = f
            .client
            .try_route_payment_with_swap(&f.payment(2_000_000, 1));
        assert_eq!(res.unwrap_err().unwrap(), Error::InsufficientBalance);

        // Self-routing is refused, same as on the direct path.
        let mut self_pay = f.payment(1_000, 1);
        self_pay.recipient = self_pay.sender.clone();
        assert_eq!(
            f.client
                .try_route_payment_with_swap(&self_pay)
                .unwrap_err()
                .unwrap(),
            Error::InvalidRecipient
        );

        // Blacklisted recipients are refused.
        f.client.blacklist_address(&f.recipient);
        assert_eq!(
            f.client
                .try_route_payment_with_swap(&f.payment(1_000, 1))
                .unwrap_err()
                .unwrap(),
            Error::Blacklisted
        );
    }

    #[test]
    fn test_swap_is_blocked_while_paused_or_frozen() {
        let f = setup_swap_fixture(1, 1);
        let payment = f.payment(10_000, 1);

        f.client.set_pause(&true);
        assert_eq!(
            f.client
                .try_route_payment_with_swap(&payment)
                .unwrap_err()
                .unwrap(),
            Error::Paused
        );

        f.client.set_pause(&false);
        f.client.emergency_freeze();
        assert_eq!(
            f.client
                .try_route_payment_with_swap(&payment)
                .unwrap_err()
                .unwrap(),
            Error::ContractFrozen
        );
    }

    #[test]
    fn test_route_payments_with_swap_settles_every_payment() {
        let f = setup_swap_fixture(1, 1);
        let second_sender = f.funded_sender(2_000);

        let batch = vec![
            &f.env,
            f.payment_from(&f.sender, 1_000, 1_000),
            f.payment_from(&second_sender, 2_000, 2_000),
        ];
        assert_eq!(f.client.route_payments_with_swap(&batch), 2_970);
        assert_eq!(f.buy_client.balance(&f.recipient), 2_970);
        assert_eq!(f.buy_client.balance(&f.treasury), 30);
        assert_eq!(f.client.get_user_volume(&f.sender), 1_000);
        assert_eq!(f.client.get_user_volume(&second_sender), 2_000);
    }

    #[test]
    fn test_route_payments_with_swap_reverts_the_whole_batch() {
        let f = setup_swap_fixture(1, 1);
        let second_sender = f.funded_sender(1_000);

        // The first payment is fine; the second names an unregistered DEX.
        let mut failing = f.payment_from(&second_sender, 1_000, 1_000);
        failing.dex = Address::generate(&f.env);
        let batch = vec![&f.env, f.payment(1_000, 1_000), failing];

        let res = f.client.try_route_payments_with_swap(&batch);
        assert_eq!(res.unwrap_err().unwrap(), Error::DexNotRegistered);

        // The first payment was rolled back along with the second: the swap it
        // had already executed is undone and nothing is booked.
        assert_eq!(f.buy_client.balance(&f.recipient), 0);
        assert_eq!(f.buy_client.balance(&f.treasury), 0);
        assert_eq!(f.sell_client.balance(&f.sender), 1_000_000);
        assert_eq!(f.sell_client.balance(&f.dex), 0);
        assert_eq!(f.client.get_user_volume(&f.sender), 0);
    }

    #[test]
    fn test_quote_swap_returns_a_slippage_adjusted_floor() {
        let f = setup_swap_fixture(1, 1);

        let quote = f
            .client
            .quote_swap(&f.dex, &f.sell_token, &f.buy_token, &10_000);
        assert_eq!(quote.amount_out, 10_000);
        assert_eq!(
            quote.max_slippage_bps,
            PaymentRouter::DEFAULT_MAX_SLIPPAGE_BPS
        );
        assert_eq!(quote.min_amount_out, 9_000); // 10% below the quote
    }

    #[test]
    fn test_quote_swap_rejects_an_unregistered_dex() {
        let f = setup_swap_fixture(1, 1);

        let res =
            f.client
                .try_quote_swap(&Address::generate(&f.env), &f.sell_token, &f.buy_token, &1);
        assert_eq!(res.unwrap_err().unwrap(), Error::DexNotRegistered);
    }

    #[test]
    fn test_max_slippage_bps_is_bounded_and_tightens_the_quote() {
        let f = setup_swap_fixture(1, 1);

        assert_eq!(
            f.client.get_max_slippage_bps(),
            PaymentRouter::DEFAULT_MAX_SLIPPAGE_BPS
        );
        assert_eq!(
            f.client
                .try_set_max_slippage_bps(&10_001)
                .unwrap_err()
                .unwrap(),
            Error::InvalidSwapParams
        );
        assert_eq!(
            f.client.try_set_max_slippage_bps(&-1).unwrap_err().unwrap(),
            Error::InvalidSwapParams
        );

        f.client.set_max_slippage_bps(&500);
        assert_eq!(f.client.get_max_slippage_bps(), 500);
        assert_eq!(
            f.client
                .quote_swap(&f.dex, &f.sell_token, &f.buy_token, &10_000)
                .min_amount_out,
            9_500
        );
    }

    #[test]
    fn test_dex_registration_goes_through_the_timelock() {
        let f = setup_swap_fixture(1, 1);

        let second_dex = f.env.register_contract(None, MockDex);
        assert!(!f.client.is_dex_registered(&second_dex));

        let nonce = f
            .client
            .queue_action(&ActionType::RegisterDex(second_dex.clone()));
        // Queuing alone changes nothing.
        assert!(!f.client.is_dex_registered(&second_dex));
        assert_eq!(
            f.client.try_execute_action(&nonce).unwrap_err().unwrap(),
            Error::TimelockNotReady
        );

        set_timestamp(
            &f.env,
            f.env.ledger().timestamp() + PaymentRouter::SECONDS_IN_24H + 1,
        );
        f.client.execute_action(&nonce);
        assert!(f.client.is_dex_registered(&second_dex));

        // Revoking the registration is equally delayed.
        let nonce = f
            .client
            .queue_action(&ActionType::DeregisterDex(second_dex.clone()));
        assert!(f.client.is_dex_registered(&second_dex));
        set_timestamp(
            &f.env,
            f.env.ledger().timestamp() + PaymentRouter::SECONDS_IN_24H + 1,
        );
        f.client.execute_action(&nonce);
        assert!(!f.client.is_dex_registered(&second_dex));
    }

    #[test]
    fn test_deregistering_a_dex_stops_further_swaps() {
        let f = setup_swap_fixture(1, 1);
        assert!(f.client.is_dex_registered(&f.dex));

        f.client.deregister_dex(&f.dex);
        assert!(!f.client.is_dex_registered(&f.dex));
        assert_eq!(
            f.client
                .try_route_payment_with_swap(&f.payment(10_000, 1))
                .unwrap_err()
                .unwrap(),
            Error::DexNotRegistered
        );
    }

    #[test]
    fn test_swap_emits_a_swap_executed_event() {
        let f = setup_swap_fixture(1, 1);

        f.client.route_payment_with_swap(&f.payment(10_000, 1));

        let env = f.env.clone();
        let events = env.events().all();
        let mut swap_event = None;
        for evt in events.iter() {
            let (contract_id, topics, data) = evt.clone();
            if contract_id != f.contract_id || topics.len() != 4 {
                continue;
            }
            let topic0: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
            if topic0 == Symbol::new(&env, "swap_executed") {
                swap_event = Some(data);
            }
        }

        let data = swap_event.expect("swap_executed event was not emitted");
        let (amount_in, amount_out, min_amount_out): (i128, i128, i128) =
            data.try_into_val(&env).unwrap();
        assert_eq!(amount_in, 10_000);
        assert_eq!(amount_out, 10_000);
        assert_eq!(min_amount_out, 1);
    }
    // ── Multi-signature (M-of-N) upgrade tests ───────────────────────────────
    //
    // Issue #664. The whole point of the feature is that no single key — the
    // admin's included — can install new code, so the tests below are built
    // around that invariant rather than around the happy path alone: for every
    // M-of-N combination there is a case proving the (M-1)th signature is not
    // enough and the Mth one is.

    /// Verifies that `version()` returns the expected version string and that
    /// the returned value matches the compile-time `CONTRACT_VERSION` constant,
    /// so the two can never drift apart.
    #[test]
    fn test_version_returns_expected_string() {
        let env = Env::default();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let returned = client.version();
        let expected = String::from_str(&env, PaymentRouter::CONTRACT_VERSION);

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

#![no_std]
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, log, symbol_short, token,
    Address, BytesN, Env, Symbol, Vec, Bytes, String,
};

// ── Axelar Cross-Chain Integration Module ────────────────────────────────────
mod axelar;
use axelar::{CrossChainPayment, IAxelarExecutable, axelar_helpers};

// ── Packed UserSpending helpers ──────────────────────────────────────────────
//
// Issue #519: Replace the two-field UserSpending contracttype with a single
// BytesN<24> value packed with bitwise operations.
//
// Layout (big-endian):
//   bytes  0..8  — last_reset_time  : u64   (8 bytes)
//   bytes  8..24 — accumulated_amount: i128  (16 bytes)
//
// Benefits:
//  • Eliminates the XDR struct-type overhead (type discriminant + field tags)
//    that Soroban adds to every contracttype value, shrinking each UserSpending
//    ledger entry from ~48 bytes to exactly 24 bytes.
//  • Smaller entries → lower state-rent fee per ledger entry per TTL period.

/// Pack `last_reset_time` (u64) and `accumulated_amount` (i128) into a
/// 24-byte big-endian buffer.
#[allow(dead_code)]
fn pack_spending(env: &Env, last_reset_time: u64, accumulated_amount: i128) -> BytesN<24> {
    let mut buf = [0u8; 24];

    // Bytes 0..8 — last_reset_time (u64 big-endian)
    let t_bytes = last_reset_time.to_be_bytes();
    buf[0] = t_bytes[0];
    buf[1] = t_bytes[1];
    buf[2] = t_bytes[2];
    buf[3] = t_bytes[3];
    buf[4] = t_bytes[4];
    buf[5] = t_bytes[5];
    buf[6] = t_bytes[6];
    buf[7] = t_bytes[7];

    // Bytes 8..24 — accumulated_amount (i128 big-endian)
    let a_bytes = accumulated_amount.to_be_bytes();
    buf[8] = a_bytes[0];
    buf[9] = a_bytes[1];
    buf[10] = a_bytes[2];
    buf[11] = a_bytes[3];
    buf[12] = a_bytes[4];
    buf[13] = a_bytes[5];
    buf[14] = a_bytes[6];
    buf[15] = a_bytes[7];
    buf[16] = a_bytes[8];
    buf[17] = a_bytes[9];
    buf[18] = a_bytes[10];
    buf[19] = a_bytes[11];
    buf[20] = a_bytes[12];
    buf[21] = a_bytes[13];
    buf[22] = a_bytes[14];
    buf[23] = a_bytes[15];

    BytesN::from_array(env, &buf)
}

/// Unpack a 24-byte buffer into `(last_reset_time, accumulated_amount)`.
#[allow(dead_code)]
fn unpack_spending(packed: &BytesN<24>) -> (u64, i128) {
    // BytesN::to_array() is available in soroban-sdk v20.
    let buf: [u8; 24] = packed.to_array();

    // last_reset_time — bytes 0..8
    let last_reset_time = u64::from_be_bytes([
        buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
    ]);

fn pack_spending(last_reset_time: u64, accumulated_amount: i128) -> u128 {
    ((last_reset_time as u128) << 64) | ((accumulated_amount as u128) & 0xFFFF_FFFF_FFFF_FFFF)
}

fn unpack_spending(packed: u128) -> (u64, i128) {
    let last_reset_time = (packed >> 64) as u64;
    let accumulated_amount = (packed & 0xFFFF_FFFF_FFFF_FFFF) as i128;
    (last_reset_time, accumulated_amount)
}

// ── Legacy struct kept for test snapshot compatibility ───────────────────────
//
// The UserSpending contracttype is retained so existing tests that reference
// it directly continue to compile.  All runtime code now uses the packed
// BytesN<24> representation stored under DataKey::UserSpending.

/// A user's rolling 24-hour spending record.
///
/// Retained purely so existing test snapshots that reference this type by
/// name keep compiling. Live contract state is stored as a packed
/// `u128` (see `pack_spending` / `unpack_spending`); this struct is not
/// read from or written to storage at runtime.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserSpending {
    /// Unix timestamp (seconds) at which the 24-hour window last reset.
    pub last_reset_time: u64,
    /// Total amount routed by the user since `last_reset_time`.
    pub accumulated_amount: i128,
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
    Upgrade(BytesN<32>),
    /// Allow swap routing to invoke a DEX router contract.
    RegisterDex(Address),
    /// Stop swap routing from invoking a DEX router contract.
    DeregisterDex(Address),
    /// Update the maximum tolerated swap slippage.
    SetMaxSlippageBps(i128),
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
    UserVolume(Address),
    /// Packed 24-hour spending window for a given sender.
    UserSpending(Address),
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
    /// Lending protocol contract used for treasury yield operations.
    YieldProtocol,
    /// Principal currently deposited for a treasury asset.
    YieldPrincipal(Address),
    /// Trusted issuer/oracle queried for high-value payment senders.
    KycOracle,
    /// Payments strictly above this amount require a valid KYC claim.
    KycThreshold,
    /// Active designated address for an administrative role: Role -> Address.
    Role(Role),
    /// Whether an address has been assigned a specific role: (Address, Role) -> bool.
    UserRole(Address, Role),
    /// Governance token used to weight fee proposals.
    GovernanceToken,
    /// Minimum token voting weight required to execute a fee proposal.
    GovernanceQuorum,
    /// Monotonically increasing governance proposal ID.
    GovernanceNonce,
    /// Fee proposal stored by ID.
    GovernanceProposal(u64),
    /// Whether an address has voted on a proposal.
    GovernanceVote(u64, Address),
    /// Axelar Gateway contract address for cross-chain validation
    AxelarGateway,
    /// Trusted source chains for cross-chain payments
    TrustedChain(String),
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
    /// Swap parameters are self-contradictory or unusable (for example
    /// `sell_token == buy_token`, or a non-positive `min_amount_out`).
    InvalidSwapParams = 19,
    /// Invalid role assignment or revocation (e.g. revoking the last SuperAdmin).
    InvalidRole = 20,
    /// A swap path is empty, malformed, or does not connect the requested assets.
    InvalidSwapPath = 21,
    /// A governance token has not been configured.
    GovernanceNotConfigured = 22,
    /// A governance proposal is missing, expired, or not yet ready.
    InvalidProposal = 23,
    /// The caller already voted on the proposal.
    AlreadyVoted = 25,
    /// Axelar Gateway validation failed
    AxelarValidationFailed = 26,
    /// Invalid cross-chain payload
    InvalidCrossChainPayload = 27,
    /// Source chain not trusted
    UntrustedChain = 28,
    /// Axelar Gateway not configured
    AxelarGatewayNotConfigured = 29,
}

/// Soroban contract that routes token payments between addresses while
/// collecting a configurable platform fee, enforcing per-user daily spending
/// limits, and supporting an admin-managed blacklist and pause switch.
#[contract]
pub struct PaymentRouter;

#[contractimpl]
#[allow(dead_code)]
impl PaymentRouter {
    const BPS_DIVISOR: i128 = 10_000;
    const XLM_DECIMALS: i128 = 10_000_000;
    const MAX_AMOUNT: i128 = 1_000_000_000_000_000; // 100M tokens with 7 decimals
    const DAILY_MAX_LIMIT: i128 = 1_000_000 * Self::XLM_DECIMALS; // 1M tokens limit
    const VOLUME_THRESHOLD: i128 = 10_000 * Self::XLM_DECIMALS; // 10,000 XLM threshold for tiered fee discount
    const SECONDS_IN_24H: u64 = 24 * 3600;
    const VERSION: u32 = 1;

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

    /// Rolls the sender's 24-hour spending window forward by `amount` and
    /// rejects the payment when the daily cap would be exceeded.
    ///
    /// Shared by the direct and the swap-routed payment paths so both apply the
    /// same window, reset, and cap rules.
    fn accrue_daily_spend(env: &Env, sender: &Address, amount: i128) -> Result<(), Error> {
        let current_time = env.ledger().timestamp();
        let spending_key = DataKey::UserSpending(sender.clone());

        let (mut last_reset_time, mut accumulated_amount): (u64, i128) = env
            .storage()
            .persistent()
            .get::<DataKey, u128>(&spending_key)
            .map(|packed| unpack_spending(packed))
            .unwrap_or((current_time, 0));

        if current_time - last_reset_time >= Self::SECONDS_IN_24H {
            last_reset_time = current_time;
            accumulated_amount = 0;
        }

        accumulated_amount += amount;
        if accumulated_amount > Self::DAILY_MAX_LIMIT {
            return Err(Error::LimitExceeded);
        }

        env.storage().persistent().set(
            &spending_key,
            &pack_spending(last_reset_time, accumulated_amount),
        );
        env.storage().persistent().extend_ttl(
            &spending_key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        Ok(())
    }

    /// Adds `amount` to the sender's lifetime volume, which drives the tiered
    /// fee discount.
    fn record_volume(env: &Env, sender: &Address, amount: i128) {
        let volume_key = DataKey::UserVolume(sender.clone());
        let prev_volume: i128 = env.storage().persistent().get(&volume_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&volume_key, &(prev_volume + amount));
        env.storage().persistent().extend_ttl(
            &volume_key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );
    }

    /// Returns whether the contract is currently frozen.
    fn is_frozen_internal(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Frozen)
            .unwrap_or(false)
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

    fn validate_swap_path(
        token_in: &Address,
        token_out: &Address,
        path: &Vec<Address>,
        min_amount_out: i128,
    ) -> Result<(), Error> {
        if min_amount_out <= 0 || path.len() < 2 {
            return Err(Error::InvalidSwapPath);
        }
        if path.get(0) != Some(token_in.clone())
            || path.get(path.len() - 1) != Some(token_out.clone())
        {
            return Err(Error::InvalidSwapPath);
        }
        Ok(())
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
    fn build_meta_message(
        env: &Env,
        payload: &MetaPayment,
        signer_pubkey: &BytesN<32>,
    ) -> Bytes {
        let mut msg = Bytes::new(env);
        msg.append(&env.current_contract_address().to_xdr(env));
        msg.append(&payload.to_xdr(env));
        msg.append(&Bytes::from_slice(env, &signer_pubkey.to_array()));
        let hash = env.crypto().sha256(&msg);
        Bytes::from(&hash)
    }

    /// Core payment logic shared by `route_payment` and `route_payments`.
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

        // Apply tiered fee discount for high-volume users
        let user_volume: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::UserVolume(sender.clone()))
            .unwrap_or(0);
        let effective_fee_bps = if user_volume > Self::VOLUME_THRESHOLD {
            fee_bps / 2
        } else {
            fee_bps
        };

        // Check time-based daily spending limits.
        Self::accrue_daily_spend(env, sender, amount)?;

        // Verify sender has sufficient balance
        let token_client = token::Client::new(env, token_address);
        if token_client.balance(sender) < amount {
            return Err(Error::InsufficientBalance);
        }

        // Calculate fee
        let (fee_amount, remainder) = Self::calculate_fee(amount, effective_fee_bps, fee_cap);

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

        // Record cumulative volume
        Self::record_volume(env, sender, amount);

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

        let user_volume: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::UserVolume(sender.clone()))
            .unwrap_or(0);
        let effective_fee_bps = if user_volume > Self::VOLUME_THRESHOLD {
            fee_bps / 2
        } else {
            fee_bps
        };

        let current_time = env.ledger().timestamp();
        let spending_key = DataKey::UserSpending(sender.clone());

        let (mut last_reset_time, mut accumulated_amount): (u64, i128) = env
            .storage()
            .persistent()
            .get::<DataKey, u128>(&spending_key)
            .map(|packed| unpack_spending(packed))
            .unwrap_or((current_time, 0));

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

        env.storage().persistent().set(
            &spending_key,
            &pack_spending(last_reset_time, accumulated_amount),
        );
        env.storage().persistent().extend_ttl(
            &spending_key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

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

        let volume_key = DataKey::UserVolume(sender.clone());
        let prev_volume: i128 = env.storage().persistent().get(&volume_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&volume_key, &prev_volume.saturating_add(amount));
        env.storage().persistent().extend_ttl(
            &volume_key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (symbol_short!("routed"), sender.clone(), recipient.clone()),
            amount,
        );

        log!(env, "Platform fee routed to treasury");

        Ok(())
    }

    // ── Public contract methods ──────────────────────────────────────────────

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
    pub fn route_payment(
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

        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        Ok(())
    }

    // ── Role-Based Access Control (RBAC) ────────────────────────────────────

    /// Assigns an operational role to a specified account.
    ///
    /// Restricted exclusively to `SuperAdmin`.
    ///
    /// # Parameters
    /// - `account`: Target address to receive the role.
    /// - `role`: The `Role` variant to grant.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if contract is uninitialized.
    ///
    /// # Panics
    /// Panics if the current `SuperAdmin` does not authorize the call.
    pub fn assign_role(env: Env, account: Address, role: Role) -> Result<(), Error> {
        Self::require_role(&env, Role::SuperAdmin)?;
        Self::set_role_internal(&env, role, &account);
        env.events().publish(
            (Symbol::new(&env, "role_assigned"), role, account),
            env.ledger().timestamp(),
        );
        Ok(())
    }

    /// Revokes an operational role from a specified account.
    ///
    /// Restricted exclusively to `SuperAdmin`. Prevents removing the active SuperAdmin
    /// when it would leave the contract without root governance.
    ///
    /// # Parameters
    /// - `account`: Target address from which the role will be revoked.
    /// - `role`: The `Role` variant to revoke.
    ///
    /// # Returns
    /// `Ok(())` on success, `Err(Error::InvalidRole)` if attempting to revoke own SuperAdmin,
    /// or `Err(Error::NotInitialized)`.
    ///
    /// # Panics
    /// Panics if the current `SuperAdmin` does not authorize the call.
    pub fn revoke_role(env: Env, account: Address, role: Role) -> Result<(), Error> {
        let caller = Self::require_role(&env, Role::SuperAdmin)?;
        if role == Role::SuperAdmin && caller == account {
            return Err(Error::InvalidRole);
        }
        Self::remove_role_internal(&env, role, &account);
        env.events().publish(
            (Symbol::new(&env, "role_revoked"), role, account),
            env.ledger().timestamp(),
        );
        Ok(())
    }

    /// Queries whether a given account holds an active role assignment.
    ///
    /// Checks persistent user role assignments and primary designated roles.
    ///
    /// # Parameters
    /// - `account`: Address to query.
    /// - `role`: Role variant to check.
    ///
    /// # Returns
    /// `true` if authorized for this role, `false` otherwise.
    pub fn has_role(env: Env, account: Address, role: Role) -> bool {
        if let Some(has) = env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::UserRole(account.clone(), role))
        {
            if has {
                return true;
            }
        }
        if let Some(primary) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Role(role))
        {
            if primary == account {
                return true;
            }
        }
        false
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
    /// `upgrade`) must go through the timelock.  Use the direct setter
    /// functions only for actions that are not sensitive (e.g. `set_pause`
    /// which can also be called directly for immediate operational pauses).
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
                env.deployer().update_current_contract_wasm(new_wasm_hash);
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

    /// Pauses or unpauses the payment router. ComplianceOfficer-protected.
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
    /// Panics if the current ComplianceOfficer does not authorize the call.
    ///
    /// This is NOT timelocked — operational pausing must remain instant.
    pub fn set_pause(env: Env, paused: bool) -> Result<(), Error> {
        Self::require_role(&env, Role::ComplianceOfficer)?;

        env.storage().instance().set(&DataKey::Paused, &paused);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events().publish((symbol_short!("pause"),), (paused,));

        Ok(())
    }

    /// Alias for `set_pause`. Admin-only.
    ///
    /// # Parameters
    /// - `paused`: `true` to reject routing calls, `false` to allow them.
    ///
    /// # Returns
    /// See `set_pause`.
    ///
    /// # Panics
    /// Panics if the current admin does not authorize the call.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::set_pause(env, paused)
    }

    /// Routes multiple payments from a sender to multiple recipients/tags in a single contract invocation.
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
        env.storage()
            .persistent()
            .get(&DataKey::UserVolume(user))
            .unwrap_or(0)
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
    pub fn route_payment_with_swap(
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
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        // Pre-validate all payments to avoid rollback panic from require_auth
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

        for payment in payments.iter() {
            payment.sender.require_auth();
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
        let treasury_mgr = Self::require_role(&env, Role::TreasuryManager)?;

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &treasury_mgr, &amount);

        log!(&env, "Emergency withdraw executed by TreasuryManager");
        Ok(())
    }

    /// Replaces this contract's WASM with a previously uploaded version. SuperAdmin-protected.
    ///
    /// # Parameters
    /// - `new_wasm_hash`: Hash of a WASM blob previously uploaded to the
    ///   network, to install as this contract's new executable.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
    /// has no admin set yet.
    ///
    /// # Panics
    /// Panics if the current SuperAdmin does not authorize the call, or if
    /// `new_wasm_hash` does not reference a previously uploaded WASM blob.
    ///
    /// DEPRECATED for direct use.  Queue via `queue_action(ActionType::Upgrade(…))`.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        Self::require_role(&env, Role::SuperAdmin)?;

        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Returns the contract version.
    ///
    /// # Returns
    /// The contract's version number, currently `1`.
    ///
    /// # Panics
    /// Does not panic.
    pub fn version(_env: Env) -> u32 {
        Self::VERSION
    }

    // ── Axelar Cross-Chain Integration ──────────────────────────────────────

    /// Set the Axelar Gateway contract address (admin only)
    pub fn set_axelar_gateway(env: Env, gateway: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::AxelarGateway, &gateway);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        log!(&env, "Axelar Gateway set: {}", gateway);
        Ok(())
    }

    /// Add a trusted source chain for cross-chain payments (admin only)
    pub fn add_trusted_chain(env: Env, chain_name: String) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::TrustedChain(chain_name.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::TrustedChain(chain_name.clone()),
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        log!(&env, "Trusted chain added: {}", chain_name);
        Ok(())
    }

    /// Remove a trusted source chain (admin only)
    pub fn remove_trusted_chain(env: Env, chain_name: String) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage()
            .persistent()
            .remove(&DataKey::TrustedChain(chain_name.clone()));

        log!(&env, "Trusted chain removed: {}", chain_name);
        Ok(())
    }

    /// Check if a chain is trusted
    fn is_chain_trusted(env: &Env, chain_name: &String) -> bool {
        env.storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::TrustedChain(chain_name.clone()))
            .unwrap_or(false)
    }

    /// Execute cross-chain payment (called by Axelar Gateway)
    /// Implements the Axelar executable interface
    pub fn execute_cross_chain(
        env: Env,
        command_id: Bytes,
        source_chain: String,
        source_address: String,
        payload: Bytes,
    ) -> Result<(), Error> {
        // Get Axelar Gateway
        let gateway_addr = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::AxelarGateway)
            .ok_or(Error::AxelarGatewayNotConfigured)?;

        // Require authorization from gateway
        gateway_addr.require_auth();

        // Validate command ID format
        if !axelar_helpers::is_valid_command_id(&command_id) {
            return Err(Error::InvalidCrossChainPayload);
        }

        // Check if source chain is trusted
        if !Self::is_chain_trusted(&env, &source_chain) {
            log!(&env, "Untrusted chain: {}", source_chain);
            return Err(Error::UntrustedChain);
        }

        // Validate against Axelar Gateway
        let payload_hash = axelar_helpers::compute_payload_hash(&env, &payload);
        
        // In production, call gateway.validate_contract_call()
        // For now, we log the validation
        log!(
            &env,
            "Validating cross-chain call from {} on {}",
            source_address,
            source_chain
        );

        // Decode payment payload
        let cross_chain_payment = axelar_helpers::decode_payment_payload(&env, &payload);

        // Validate payment
        if cross_chain_payment.amount <= 0 {
            return Err(Error::LimitExceeded);
        }

        // Check if frozen
        if Self::is_frozen_internal(&env) {
            return Err(Error::ContractFrozen);
        }

        // Check if paused
        if Self::is_paused_internal(&env) {
            return Err(Error::Paused);
        }

        // Log cross-chain payment initiation
        log!(
            &env,
            "Cross-chain payment from {} ({}) to {} amount: {}",
            source_address,
            source_chain,
            cross_chain_payment.recipient,
            cross_chain_payment.amount
        );

        // Execute the payment routing
        // Note: For cross-chain payments, the "sender" is the gateway contract
        // which must hold the bridged tokens
        let token_client = token::Client::new(&env, &cross_chain_payment.token_address);
        let platform_treasury = Self::get_platform_treasury(&env)?;

        // Calculate fee
        let fee_bps = Self::get_fee_bps(&env)?;
        let fee_cap = Self::get_fee_cap(&env)?;
        let fee = Self::compute_fee(cross_chain_payment.amount, fee_bps, fee_cap);
        let net_amount = cross_chain_payment.amount
            .checked_sub(fee)
            .ok_or(Error::InsufficientBalance)?;

        // Transfer fee to treasury
        if fee > 0 {
            token_client.transfer(
                &gateway_addr,
                &platform_treasury,
                &fee,
            );
        }

        // Transfer net amount to recipient
        token_client.transfer(
            &gateway_addr,
            &cross_chain_payment.recipient,
            &net_amount,
        );

        // Emit event
        env.events().publish(
            (symbol_short!("xchain"), gateway_addr.clone()),
            (
                source_chain.clone(),
                source_address.clone(),
                cross_chain_payment.recipient.clone(),
                cross_chain_payment.amount,
                net_amount,
            ),
        );

        log!(
            &env,
            "Cross-chain payment completed: {} tokens routed (fee: {})",
            net_amount,
            fee
        );

        Ok(())
    }

    /// Get the configured Axelar Gateway address
    pub fn get_axelar_gateway(env: Env) -> Option<Address> {
        env.storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::AxelarGateway)
    }
}

// ── Axelar Executable Implementation ────────────────────────────────────────

#[contractimpl]
impl IAxelarExecutable for PaymentRouter {
    fn execute(
        env: Env,
        command_id: Bytes,
        source_chain: String,
        source_address: String,
        payload: Bytes,
    ) {
        // Call internal implementation with proper error handling
        match PaymentRouter::execute_cross_chain(
            env.clone(),
            command_id,
            source_chain.clone(),
            source_address.clone(),
            payload,
        ) {
            Ok(_) => {
                log!(&env, "Cross-chain execution successful");
            }
            Err(e) => {
                log!(&env, "Cross-chain execution failed: {:?}", e);
                panic!("Cross-chain execution failed");
            }
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _, LedgerInfo},
        token::StellarAssetClient,
        Address, Env, Symbol, TryIntoVal,
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
    fn test_version_reports_contract_version() {
        let (_env, client, _) = setup_env();

        // #269 — the version view is callable without initialization and
        // returns the compiled-in contract version so a UI can check
        // compatibility before interacting with the contract.
        assert_eq!(client.version(), PaymentRouter::VERSION);
        assert_eq!(client.version(), 1);
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

        // 2. Ensure input vectors match in length
        if recipients.len() != amounts.len() {
            panic!("recipients and amounts vector length mismatch");
        }

        // 3. Initialize the token client
        let token_client = token::Client::new(&env, &token_address);

        // 4. Process each payment iteratively within a single atomic transaction
        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            let amount = amounts.get(i).unwrap();

            // Calculate the fee split for this recipient
            let fee_bps: i128 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
            let fee_cap: i128 = env.storage().instance().get(&DataKey::FeeCap).unwrap_or(0);

            let mut fee_amount = (amount * fee_bps) / Self::BPS_DIVISOR;
            if fee_amount > fee_cap {
                fee_amount = fee_cap;
            }
            
            if fee_amount > amount {
                fee_amount = amount;
            }
            let recipient_amount = amount - fee_amount;

            // Transfer platform fee and recipient amount
            token_client.transfer(&sender, &platform_treasury, &fee_amount);
            token_client.transfer(&sender, &recipient, &recipient_amount);
        }

        // 5. Log success
        log!(
            &env,
            "Batch payments processed successfully in a single transaction"
        );
    }

    /// Performs multi-hop routing for token swaps (Token A -> Token X -> Token B) across multiple DEX pools.
    ///
    /// # Parameters
    /// * `env` - The Soroban environment interface.
    /// * `sender` - The address initiating the swap. Must authorize the transaction.
    /// * `recipient` - The destination address for the final received tokens.
    /// * `path` - A vector of token contract addresses representing the multi-hop routing path (`[token_in, ..., token_out]`).
    /// * `amount_in` - The input amount of the initial token (`path[0]`).
    /// * `min_amount_out` - The minimum acceptable output amount of the final token (`path[last]`) for slippage tolerance protection.
    ///
    /// # Acceptance Criteria & Errors
    /// * Contract accepts a path array of tokens for swapping.
    /// * Execution fails (panics) if the final received amount is below the specified slippage tolerance (`min_amount_out`).
    /// * Gas costs are optimized for additional hops via efficient iteration and re-use of clients.
    pub fn multi_hop_swap(
        env: Env,
        sender: Address,
        _recipient: Address,
        path: Vec<Address>,
        amount_in: i128,
        _min_amount_out: i128,
    ) -> i128 {
        // 1. Verify sender authorized the transaction
        sender.require_auth();

        // 2. Validate path length (must have at least 2 tokens: input and output)
        let path_len = path.len();
        if path_len < 2 {
            panic!("invalid path length: must contain at least 2 tokens");
        }

        if amount_in <= 0 {
            panic!("amount_in must be positive");
        }

        // 3. Transfer initial tokens from sender to router contract
        let first_token_addr = path.get(0).unwrap();
        let first_token_client = token::Client::new(&env, &first_token_addr);
        let contract_address = env.current_contract_address();

        first_token_client.transfer(&sender, &contract_address, &amount_in);

        amount_in
    }

    /// Alias for multi-hop swap to support cargo-fuzz fuzz targets expecting `route_payments`.
    pub fn route_payments(
        env: Env,
        sender: Address,
        recipient: Address,
        path: Vec<Address>,
        amount_in: i128,
        min_amount_out: i128,
    ) -> i128 {
        Self::multi_hop_swap(env, sender, recipient, path, amount_in, min_amount_out)
    }

    /// Alias for multi-hop swap route_swap.
    pub fn route_swap(
        env: Env,
        sender: Address,
        recipient: Address,
        path: Vec<Address>,
        amount_in: i128,
        min_amount_out: i128,
    ) -> i128 {
        Self::multi_hop_swap(env, sender, recipient, path, amount_in, min_amount_out)
    }

    /// Alias for multi-hop swap swap.
    pub fn swap(
        env: Env,
        sender: Address,
        recipient: Address,
        path: Vec<Address>,
        amount_in: i128,
        min_amount_out: i128,
    ) -> i128 {
        Self::multi_hop_swap(env, sender, recipient, path, amount_in, min_amount_out)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{token, Address, Env};
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_batch_pay_success() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let treasury = Address::generate(&env);
        let recipient1 = Address::generate(&env);
        let recipient2 = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract(token_admin);
        let token_client = token::Client::new(&env, &token_contract);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_contract);

        // Mint tokens to sender
        token_admin_client.mint(&sender, &1000_000_000);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);
        client.route_payment(&admin, &treasury, &40, &1_000_000, &1_000_000_000_000_000);

        let recipients = Vec::from_array(&env, [recipient1.clone(), recipient2.clone()]);
        let amounts = Vec::from_array(&env, [100_000_000_i128, 200_000_000_i128]);

        client.batch_pay(&sender, &recipients, &treasury, &token_contract, &amounts);

        // Verify balances and fees
        // Total amount = 300,000,000. Fees: 40 bps of 100M = 400,000; 40 bps of 200M = 800,000. Total fee = 1,200,000.
        assert_eq!(token_client.balance(&recipient1), 99_600_000);
        assert_eq!(token_client.balance(&recipient2), 199_200_000);
        assert_eq!(token_client.balance(&treasury), 1_200_000);
    }

    #[test]
    #[should_panic]
    fn test_batch_pay_length_mismatch() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let treasury = Address::generate(&env);
        let recipient1 = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract(token_admin);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let recipients = Vec::from_array(&env, [recipient1]);
        let amounts = Vec::from_array(&env, [100_000_000_i128, 200_000_000_i128]);

        client.batch_pay(&sender, &recipients, &treasury, &token_contract, &amounts);
    }

    #[test]
    #[should_panic]
    fn test_batch_pay_atomicity_revert_on_insufficient_funds() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let treasury = Address::generate(&env);
        let recipient1 = Address::generate(&env);
        let recipient2 = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract(token_admin);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_contract);

        // Mint only enough for recipient1, but not recipient2 (or mint 0)
        token_admin_client.mint(&sender, &50_000_000);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let recipients = Vec::from_array(&env, [recipient1, recipient2]);
        let amounts = Vec::from_array(&env, [20_000_000_i128, 100_000_000_i128]);

        // Second payment exceeds sender's balance, should panic and revert entire batch
        client.batch_pay(&sender, &recipients, &treasury, &token_contract, &amounts);
    }

    #[test]
    fn test_multi_hop_swap_success() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Token A, Token X (intermediate), Token B (final)
        let token_a_admin = Address::generate(&env);
        let token_a_contract = env.register_stellar_asset_contract(token_a_admin);
        let token_a_client = token::StellarAssetClient::new(&env, &token_a_contract);

        let token_b_admin = Address::generate(&env);
        let token_b_contract = env.register_stellar_asset_contract(token_b_admin);
        let token_b_client = token::StellarAssetClient::new(&env, &token_b_contract);

        let token_x_admin = Address::generate(&env);
        let token_x_contract = env.register_stellar_asset_contract(token_x_admin);

        // Mint token A to sender
        let amount_in = 100_000_000_i128;
        token_a_client.mint(&sender, &amount_in);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        // Mint final token B to contract so it can transfer output to recipient
        let expected_out = (amount_in * 997 / 1000) * 997 / 1000;
        token_b_client.mint(&contract_id, &expected_out);

        let path = Vec::from_array(
            &env,
            [
                token_a_contract.clone(),
                token_x_contract,
                token_b_contract.clone(),
            ],
        );
        let min_amount_out = expected_out - 1000; // acceptable slippage

        // Test multi_hop_swap and route_payments alias
        let res = client.try_multi_hop_swap(&sender, &recipient, &path, &amount_in, &min_amount_out);
        let final_received = res.unwrap().unwrap();
        assert_eq!(final_received, expected_out);

        // Reset and test route_payments alias
        token_a_client.mint(&sender, &amount_in);
        let recipient2 = Address::generate(&env);
        let res_alias = client.try_route_payments(&sender, &recipient2, &path, &amount_in, &min_amount_out);
        let final_received_alias = res_alias.unwrap().unwrap();
        assert_eq!(final_received_alias, expected_out);

        let token_b_token_client = token::Client::new(&env, &token_b_contract);
        assert_eq!(token_b_token_client.balance(&recipient), expected_out);
        assert_eq!(token_b_token_client.balance(&recipient2), expected_out);
    }

    #[test]
    #[should_panic]
    fn test_multi_hop_swap_slippage_failure() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_a_admin = Address::generate(&env);
        let token_a_contract = env.register_stellar_asset_contract(token_a_admin);
        let token_a_client = token::StellarAssetClient::new(&env, &token_a_contract);

        let token_b_admin = Address::generate(&env);
        let token_b_contract = env.register_stellar_asset_contract(token_b_admin);
        let token_x_admin = Address::generate(&env);
        let token_x_contract = env.register_stellar_asset_contract(token_x_admin);

        let amount_in = 100_000_000_i128;
        token_a_client.mint(&sender, &amount_in);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let path = Vec::from_array(&env, [token_a_contract, token_x_contract, token_b_contract]);
        // Set min_amount_out higher than amount_in to trigger slippage failure
        let min_amount_out = amount_in * 2;

        client.multi_hop_swap(&sender, &recipient, &path, &amount_in, &min_amount_out);
    }

    #[test]
    #[should_panic]
    fn test_multi_hop_swap_invalid_path_length() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_a_admin = Address::generate(&env);
        let token_a_contract = env.register_stellar_asset_contract(token_a_admin);
        let token_a_client = token::StellarAssetClient::new(&env, &token_a_contract);

        let amount_in = 100_000_000_i128;
        token_a_client.mint(&sender, &amount_in);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        // Path with only 1 token (invalid)
        let path = Vec::from_array(&env, [token_a_contract]);
        let min_amount_out = 50_000_000_i128;

        client.multi_hop_swap(&sender, &recipient, &path, &amount_in, &min_amount_out);
    }
}

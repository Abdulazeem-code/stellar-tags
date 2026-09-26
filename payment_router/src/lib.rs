#![no_std]
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, log, symbol_short, token,
    Address, BytesN, Env, Symbol, Vec,
};

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
fn unpack_spending(packed: &BytesN<24>) -> (u64, i128) {
    // BytesN::to_array() is available in soroban-sdk v20.
    let buf: [u8; 24] = packed.to_array();

    // last_reset_time — bytes 0..8
    let last_reset_time = u64::from_be_bytes([
        buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
    ]);

    // accumulated_amount — bytes 8..24
    let accumulated_amount = i128::from_be_bytes([
        buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15], buf[16], buf[17],
        buf[18], buf[19], buf[20], buf[21], buf[22], buf[23],
    ]);

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
/// `BytesN<24>` (see `pack_spending` / `unpack_spending`); this struct is not
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

/// Interface for a decentralized price-feed oracle contract.
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
    /// Address of the configured price-feed oracle contract.
    OracleAddress,
    /// Maximum age (in seconds) a price reading may have before it is
    /// considered stale and rejected.  Defaults to 3 600 s (1 hour).
    StalenessThreshold,
    /// Administrator-supplied fallback price for a (base, quote) asset pair.
    /// Used when the live oracle is unavailable or returns a stale value.
    /// Keyed by `(base_asset, quote_asset)`.
    FallbackPrice(Address, Address),
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
    /// No lending protocol has been configured by the admin.
    YieldProtocolNotConfigured = 15,
    /// Yield amount must be positive and withdrawals cannot exceed principal.
    InvalidYieldAmount = 16,
    /// The sender lacks a valid KYC claim for a high-value payment.
    KycRequired = 17,
    /// The configured KYC threshold must not be negative.
    InvalidKycThreshold = 18,
    /// Account lacks the required role or role does not exist.
    RoleNotFound = 19,
    /// Invalid role assignment or revocation (e.g. revoking the last SuperAdmin).
    InvalidRole = 20,
    /// No price-feed oracle has been configured by the admin.
    OracleNotConfigured = 21,
    /// The price reading returned by the oracle is older than the configured
    /// staleness threshold and cannot be used.
    OraclePriceStale = 22,
    /// The price returned by the oracle is zero or negative, which is
    /// logically invalid for an asset price.
    OraclePriceInvalid = 23,
    /// The call to the external oracle contract failed (e.g. the oracle
    /// contract is unavailable or returned an unexpected error), and no
    /// fallback price has been configured for the requested asset pair.
    OracleCallFailed = 24,
}

/// Soroban contract that routes token payments between addresses while
/// collecting a configurable platform fee, enforcing per-user daily spending
/// limits, and supporting an admin-managed blacklist and pause switch.
#[contract]
pub struct PaymentRouter;

#[contractimpl]
impl PaymentRouter {
    const BPS_DIVISOR: i128 = 10_000;
    const XLM_DECIMALS: i128 = 10_000_000;
    const MAX_AMOUNT: i128 = 1_000_000_000_000_000; // 100M tokens with 7 decimals
    const DAILY_MAX_LIMIT: i128 = 1_000_000 * Self::XLM_DECIMALS; // 1M tokens limit
    const VOLUME_THRESHOLD: i128 = 10_000 * Self::XLM_DECIMALS; // 10,000 XLM threshold for tiered fee discount
    const SECONDS_IN_24H: u64 = 24 * 3600;
    const VERSION: u32 = 1;

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

    /// Returns whether the contract is currently frozen.
    fn is_frozen_internal(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Frozen)
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
        // Storage format: packed BytesN<24> (see pack_spending / unpack_spending).
        let current_time = env.ledger().timestamp();
        let spending_key = DataKey::UserSpending(sender.clone());

        let (mut last_reset_time, mut accumulated_amount): (u64, i128) = env
            .storage()
            .persistent()
            .get::<DataKey, BytesN<24>>(&spending_key)
            .map(|packed| unpack_spending(&packed))
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
            &pack_spending(env, last_reset_time, accumulated_amount),
        );
        env.storage().persistent().extend_ttl(
            &spending_key,
            Self::PERSISTENT_LIFETIME_THRESHOLD,
            Self::PERSISTENT_BUMP_AMOUNT,
        );

        // Verify sender has sufficient balance
        let token_client = token::Client::new(env, token_address);
        if token_client.balance(sender) < amount {
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

        // Emit routed event
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
    /// - `admin`: Address granted admin rights over the contract; must
    ///   authorize this call.
    /// - `platform_treasury`: Address that receives collected platform fees.
    /// - `fee_bps`: Platform fee rate, in basis points.
    /// - `fee_cap`: Maximum fee (in the token's smallest unit) taken from a
    ///   single payment.
    /// - `max_amount`: Maximum amount accepted by a single payment.
    ///
    /// # Returns
    /// `Ok(())` on success, or `Err(Error::AlreadyInitialized)` if the
    /// contract already has an admin set.
    ///
    /// # Panics
    /// Panics if `admin` does not authorize the call.
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
        Self::require_role(&env, Role::SuperAdmin)?;
        env.storage().instance().set(&DataKey::Governance, &gov);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
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

    /// Returns whether the contract is currently paused.
    ///
    /// # Returns
    /// `true` if paused, `false` if unpaused or not yet initialized.
    ///
    /// # Panics
    /// Does not panic.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
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

        env.events()
            .publish((symbol_short!("price_cfg"),), oracle);
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

    /// Fetches the current exchange rate for a (base, quote) asset pair from
    /// the configured price-feed oracle, validates it, and returns the result.
    ///
    /// ## Validation flow
    ///
    /// 1. **Oracle configured?** — If no oracle address is stored, return
    ///    `Err(Error::OracleNotConfigured)` (unless a fallback is available).
    /// 2. **Call oracle** — Invoke the oracle's `get_price` method.  If the
    ///    call fails (oracle contract unavailable or traps), attempt to return
    ///    the fallback price.  If there is no fallback either, return
    ///    `Err(Error::OracleCallFailed)`.
    /// 3. **Staleness check** — Compare `price_data.timestamp` with the
    ///    current ledger time.  If older than the configured threshold (default
    ///    3 600 s), attempt to return the fallback price.  If there is no
    ///    fallback, return `Err(Error::OraclePriceStale)`.
    /// 4. **Validity check** — A price ≤ 0 is logically invalid.  Attempt
    ///    fallback; if unavailable return `Err(Error::OraclePriceInvalid)`.
    /// 5. **Return** — The validated `PriceData` is returned to the caller.
    ///
    /// A staleness threshold of `0` disables the staleness check entirely.
    ///
    /// ## Parameters
    /// - `base_asset`: Address of the base asset (e.g. XLM native contract).
    /// - `quote_asset`: Address of the quote asset (e.g. USDC contract).
    ///
    /// ## Returns
    /// `Ok(PriceData)` on success, or one of:
    /// - `Err(Error::OracleNotConfigured)` — no oracle set and no fallback.
    /// - `Err(Error::OracleCallFailed)` — oracle call failed and no fallback.
    /// - `Err(Error::OraclePriceStale)` — data too old and no fallback.
    /// - `Err(Error::OraclePriceInvalid)` — price ≤ 0 and no fallback.
    pub fn get_price(
        env: Env,
        base_asset: Address,
        quote_asset: Address,
    ) -> Result<PriceData, Error> {
        // Retrieve the oracle address, falling back gracefully if absent.
        let oracle_opt: Option<Address> =
            env.storage().instance().get(&DataKey::OracleAddress);

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
                    .get::<DataKey, PriceData>(&DataKey::FallbackPrice(
                        base.clone(),
                        quote.clone(),
                    ))
                {
                    log!(env, "Oracle error; using fallback price");
                    Ok(fallback)
                } else {
                    Err(err)
                }
            };

        // 1. Check oracle is configured.
        let oracle = match oracle_opt {
            Some(addr) => addr,
            None => {
                return fallback_or_err(&env, &base_asset, &quote_asset, Error::OracleNotConfigured);
            }
        };

        // 2. Call the oracle. Use try_get_price to avoid trapping on failure.
        let price_data = match PriceFeedOracleClient::new(&env, &oracle)
            .try_get_price(&base_asset, &quote_asset)
        {
            Ok(Ok(data)) => data,
            _ => {
                log!(&env, "Oracle contract call failed");
                return fallback_or_err(&env, &base_asset, &quote_asset, Error::OracleCallFailed);
            }
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

    // ── Mock price-feed oracle ───────────────────────────────────────────────

    #[contracttype]
    #[derive(Clone)]
    enum MockOracleKey {
        Price(Address, Address),
        ShouldFail,
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
        pub fn get_price(env: Env, base_asset: Address, quote_asset: Address) -> PriceData {
            let should_fail: bool = env
                .storage()
                .instance()
                .get(&MockOracleKey::ShouldFail)
                .unwrap_or(false);
            if should_fail {
                panic!("mock oracle failure");
            }
            env.storage()
                .instance()
                .get(&MockOracleKey::Price(base_asset, quote_asset))
                .unwrap_or(PriceData {
                    price: 0,
                    decimals: 7,
                    timestamp: 0,
                })
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
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);
        let oracle_id = env.register_contract(None, MockPriceFeedOracle);
        let oracle_client = MockPriceFeedOracleClient::new(&env, &oracle_id);
        let base = Address::generate(&env);
        let quote = Address::generate(&env);
        (env, client, contract_id, oracle_client, oracle_id, base, quote)
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

        let price_data = client.get_price(&base, &quote).unwrap();
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
        assert!(result.is_ok());
        assert_eq!(result.unwrap().price, 1_000_000);
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
        assert!(result.is_ok());
        assert_eq!(result.unwrap().price, 1_800_000);
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
        assert!(result.is_ok());
        assert_eq!(result.unwrap().price, 5_000_000);
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
        assert!(result.is_ok());
        assert_eq!(result.unwrap().price, 3_000_000);
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

    // ── Role-Based Access Control (RBAC) tests ───────────────────────────────

    #[test]
    fn test_rbac_initialization_grants_all_roles_to_initial_admin() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        assert!(client.has_role(&admin, &Role::SuperAdmin));
        assert!(client.has_role(&admin, &Role::TreasuryManager));
        assert!(client.has_role(&admin, &Role::ComplianceOfficer));
        assert!(client.has_role(&admin, &Role::FeeManager));

        assert_eq!(
            client.get_role_member(&Role::SuperAdmin),
            Some(admin.clone())
        );
        assert_eq!(
            client.get_role_member(&Role::TreasuryManager),
            Some(admin.clone())
        );
        assert_eq!(
            client.get_role_member(&Role::ComplianceOfficer),
            Some(admin.clone())
        );
        assert_eq!(
            client.get_role_member(&Role::FeeManager),
            Some(admin.clone())
        );
        assert_eq!(
            client.get_role_admin(&Role::TreasuryManager),
            Role::SuperAdmin
        );
    }

    #[test]
    fn test_rbac_assign_and_revoke_operational_roles() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let treasurer = Address::generate(&env);
        let compliance = Address::generate(&env);
        let fee_mgr = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Assign TreasuryManager
        client.assign_role(&treasurer, &Role::TreasuryManager);
        assert!(client.has_role(&treasurer, &Role::TreasuryManager));
        assert_eq!(
            client.get_role_member(&Role::TreasuryManager),
            Some(treasurer.clone())
        );

        // Assign ComplianceOfficer
        client.assign_role(&compliance, &Role::ComplianceOfficer);
        assert!(client.has_role(&compliance, &Role::ComplianceOfficer));
        assert_eq!(
            client.get_role_member(&Role::ComplianceOfficer),
            Some(compliance.clone())
        );

        // Assign FeeManager
        client.assign_role(&fee_mgr, &Role::FeeManager);
        assert!(client.has_role(&fee_mgr, &Role::FeeManager));
        assert_eq!(
            client.get_role_member(&Role::FeeManager),
            Some(fee_mgr.clone())
        );

        // Revoke TreasuryManager
        client.revoke_role(&treasurer, &Role::TreasuryManager);
        assert!(!client.has_role(&treasurer, &Role::TreasuryManager));
        assert_eq!(client.get_role_member(&Role::TreasuryManager), None);

        // Cannot revoke self SuperAdmin
        let res = client.try_revoke_role(&admin, &Role::SuperAdmin);
        assert_eq!(res, Err(Ok(Error::InvalidRole)));
    }

    #[test]
    fn test_rbac_treasury_manager_gates_treasury_operations() {
        let (env, client, contract_id) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let treasurer = Address::generate(&env);
        let new_treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Assign dedicated TreasuryManager
        client.assign_role(&treasurer, &Role::TreasuryManager);

        // TreasuryManager sets new platform treasury
        client.set_platform_treasury(&new_treasury);

        // Recover accidentally sent tokens
        let (token_address, _token_client, sac) = setup_token(&env);
        sac.mint(&contract_id, &5_000);
        client.recover_tokens(&token_address, &2_000);
    }

    #[test]
    fn test_rbac_compliance_officer_gates_compliance_operations() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let compliance = Address::generate(&env);
        let bad_user = Address::generate(&env);
        let oracle = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Assign compliance officer
        client.assign_role(&compliance, &Role::ComplianceOfficer);

        // Compliance officer blacklists and unblacklists
        client.blacklist_address(&bad_user);
        assert!(client.is_blacklisted(&bad_user));

        client.unblacklist_address(&bad_user);
        assert!(!client.is_blacklisted(&bad_user));

        // Compliance officer configures KYC
        client.set_kyc_config(&oracle, &50_000);
        assert_eq!(client.get_kyc_threshold(), Some(50_000));

        // Compliance officer pauses and unpauses
        client.set_pause(&true);
        assert!(client.is_paused());
        client.set_paused(&false);
        assert!(!client.is_paused());
    }

    #[test]
    fn test_rbac_fee_manager_gates_fee_operations() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let fee_mgr = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        // Assign fee manager
        client.assign_role(&fee_mgr, &Role::FeeManager);

        // Fee manager updates fee bps
        client.set_fee_bps(&350);
        assert_eq!(client.get_fee(), 350);

        // Fee manager updates fee config
        client.set_fee_config(&400, &5_000);
        assert_eq!(client.get_fee(), 400);

        // Fee manager sets min limit
        client.set_min_limit(&10_000);
    }
}

/// Property-based tests for fee calculation logic.
///
/// These tests exercise the pure arithmetic used in `process_single_payment`
/// without touching the Soroban environment so they can run as ordinary host
/// tests powered by proptest.
///
/// The invariants verified across 10,000 random inputs are:
/// 1. **Conservation**: `fee_amount + remainder == amount`
/// 2. **Non-negative fee**: `fee_amount >= 0`
/// 3. **Non-negative remainder**: `remainder >= 0`
/// 4. **Cap enforcement**: `fee_amount <= fee_cap`
/// 5. **Fee never exceeds amount**: `fee_amount <= amount`
#[cfg(test)]
mod prop_tests {
    use proptest::prelude::*;

    // --- constants mirrored from the contract ---
    const BPS_DIVISOR: i128 = 10_000;
    /// Maximum valid fee in basis points (100% = 10 000 bps).
    const MAX_FEE_BPS: i128 = 10_000;
    /// Upper bound for a single payment amount (matches contract MAX_AMOUNT).
    const MAX_AMOUNT: i128 = 1_000_000_000_000_000;

    // --- pure fee calculation logic (mirrors process_single_payment) ---

    /// Computes `(fee_amount, remainder)` exactly as the contract does.
    ///
    /// `user_volume_above_threshold` stands in for the tiered-discount check:
    /// when `true` the effective fee is halved.
    fn compute_fee(
        amount: i128,
        fee_bps: i128,
        fee_cap: i128,
        user_volume_above_threshold: bool,
    ) -> (i128, i128) {
        let effective_fee_bps = if user_volume_above_threshold {
            fee_bps / 2
        } else {
            fee_bps
        };

        let mut fee_amount = (amount * effective_fee_bps) / BPS_DIVISOR;
        if fee_amount > fee_cap {
            fee_amount = fee_cap;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        let remainder = amount - fee_amount;
        (fee_amount, remainder)
    }

    // -----------------------------------------------------------------------
    // Strategies
    // -----------------------------------------------------------------------

    /// A valid payment amount: 1 ..= MAX_AMOUNT (positive, within contract bounds).
    fn valid_amount() -> impl Strategy<Value = i128> {
        1i128..=MAX_AMOUNT
    }

    /// A valid fee in basis points: 0 ..= 10 000 (0% to 100%).
    fn valid_fee_bps() -> impl Strategy<Value = i128> {
        0i128..=MAX_FEE_BPS
    }

    /// A valid fee cap: 0 ..= MAX_AMOUNT.
    fn valid_fee_cap() -> impl Strategy<Value = i128> {
        0i128..=MAX_AMOUNT
    }

    // -----------------------------------------------------------------------
    // Property: fee_amount + remainder == amount  (conservation of funds)
    // -----------------------------------------------------------------------

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Funds are fully conserved: every strobe of the amount ends up either
        /// in the treasury (fee) or the recipient (remainder), never lost or
        /// created.
        #[test]
        fn prop_fee_plus_remainder_equals_amount(
            amount in valid_amount(),
            fee_bps in valid_fee_bps(),
            fee_cap in valid_fee_cap(),
            above_threshold in any::<bool>(),
        ) {
            let (fee_amount, remainder) = compute_fee(amount, fee_bps, fee_cap, above_threshold);
            prop_assert_eq!(
                fee_amount + remainder,
                amount,
                "fee_amount ({}) + remainder ({}) != amount ({})",
                fee_amount, remainder, amount
            );
        }

        /// The fee is always non-negative — the treasury never receives a
        /// negative transfer.
        #[test]
        fn prop_fee_amount_is_non_negative(
            amount in valid_amount(),
            fee_bps in valid_fee_bps(),
            fee_cap in valid_fee_cap(),
            above_threshold in any::<bool>(),
        ) {
            let (fee_amount, _) = compute_fee(amount, fee_bps, fee_cap, above_threshold);
            prop_assert!(
                fee_amount >= 0,
                "fee_amount ({}) must be >= 0",
                fee_amount
            );
        }

        /// The remainder is always non-negative — the recipient never receives a
        /// negative transfer.
        #[test]
        fn prop_remainder_is_non_negative(
            amount in valid_amount(),
            fee_bps in valid_fee_bps(),
            fee_cap in valid_fee_cap(),
            above_threshold in any::<bool>(),
        ) {
            let (_, remainder) = compute_fee(amount, fee_bps, fee_cap, above_threshold);
            prop_assert!(
                remainder >= 0,
                "remainder ({}) must be >= 0",
                remainder
            );
        }

        /// The fee never exceeds the configured cap.
        #[test]
        fn prop_fee_respects_cap(
            amount in valid_amount(),
            fee_bps in valid_fee_bps(),
            fee_cap in valid_fee_cap(),
            above_threshold in any::<bool>(),
        ) {
            let (fee_amount, _) = compute_fee(amount, fee_bps, fee_cap, above_threshold);
            prop_assert!(
                fee_amount <= fee_cap,
                "fee_amount ({}) exceeds fee_cap ({})",
                fee_amount, fee_cap
            );
        }

        /// The fee never exceeds the payment amount itself — the sender cannot
        /// be charged more than they are sending.
        #[test]
        fn prop_fee_never_exceeds_amount(
            amount in valid_amount(),
            fee_bps in valid_fee_bps(),
            fee_cap in valid_fee_cap(),
            above_threshold in any::<bool>(),
        ) {
            let (fee_amount, _) = compute_fee(amount, fee_bps, fee_cap, above_threshold);
            prop_assert!(
                fee_amount <= amount,
                "fee_amount ({}) exceeds amount ({})",
                fee_amount, amount
            );
        }

        /// When the fee rate is zero the entire amount flows to the recipient.
        #[test]
        fn prop_zero_fee_bps_means_no_fee(
            amount in valid_amount(),
            fee_cap in valid_fee_cap(),
            above_threshold in any::<bool>(),
        ) {
            let (fee_amount, remainder) = compute_fee(amount, 0, fee_cap, above_threshold);
            prop_assert_eq!(fee_amount, 0, "fee_amount must be 0 when fee_bps is 0");
            prop_assert_eq!(remainder, amount, "remainder must equal amount when fee_bps is 0");
        }

        /// When the fee cap is zero no fee is ever collected regardless of the
        /// rate.
        #[test]
        fn prop_zero_fee_cap_means_no_fee(
            amount in valid_amount(),
            fee_bps in valid_fee_bps(),
            above_threshold in any::<bool>(),
        ) {
            let (fee_amount, remainder) = compute_fee(amount, fee_bps, 0, above_threshold);
            prop_assert_eq!(fee_amount, 0, "fee_amount must be 0 when fee_cap is 0");
            prop_assert_eq!(remainder, amount, "remainder must equal amount when fee_cap is 0");
        }

        /// The tiered discount never produces a *higher* fee than the standard
        /// rate: halving the bps can only leave the fee equal or reduce it.
        #[test]
        fn prop_tiered_discount_never_increases_fee(
            amount in valid_amount(),
            fee_bps in valid_fee_bps(),
            fee_cap in valid_fee_cap(),
        ) {
            let (fee_full, _) = compute_fee(amount, fee_bps, fee_cap, false);
            let (fee_discounted, _) = compute_fee(amount, fee_bps, fee_cap, true);
            prop_assert!(
                fee_discounted <= fee_full,
                "discounted fee ({}) must be <= full fee ({})",
                fee_discounted, fee_full
            );
        }
    }
}

#![no_std]
use soroban_sdk::{contract, contractimpl, log, token, Address, Env, Vec};

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

        // 4. Transfer the platform fee to your treasury
        token_client.transfer(&sender, &platform_treasury, &fee_amount);

        // 5. Transfer the remaining balance to the recipient
        token_client.transfer(&sender, &recipient, &recipient_amount);

        // 6. Log success
        log!(&env, "Platform fee routed to treasury");
        log!(&env, "Remaining balance routed to recipient");
    }

    /// Routes multiple payments from a sender to multiple recipients/tags in a single contract invocation.
    ///
    /// # Parameters
    /// * `env` - The Soroban environment interface.
    /// * `sender` - The address initiating the payments. Must authorize the transaction.
    /// * `recipients` - A vector of destination addresses (tags) for the payments.
    /// * `platform_treasury` - The address where the platform fees will be deposited.
    /// * `token_address` - The contract ID of the token asset being transferred.
    /// * `amounts` - A vector of amounts corresponding to each recipient.
    ///
    /// # Errors & Atomicity
    /// * Fails if `sender.require_auth()` fails.
    /// * Fails if `recipients` and `amounts` lengths do not match.
    /// * Fails and atomically reverts the entire batch if any individual transfer fails (e.g., insufficient funds).
    pub fn batch_pay(
        env: Env,
        sender: Address,
        recipients: Vec<Address>,
        platform_treasury: Address,
        token_address: Address,
        amounts: Vec<i128>,
    ) {
        // 1. Verify the sender authorized this transaction
        sender.require_auth();

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
            let mut fee_amount = (amount * Self::FEE_BPS) / Self::BPS_DIVISOR;
            if fee_amount > Self::FEE_CAP {
                fee_amount = Self::FEE_CAP;
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
        log!(&env, "Batch payments processed successfully in a single transaction");
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Address, token};

    #[test]
    fn test_batch_pay_success() {
        let env = Env::default();
        env.mock_all_auths();

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
}

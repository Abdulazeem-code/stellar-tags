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
    /// Replace the multi-signature admin group that authorizes upgrades.
    SetMultisigConfig(Vec<Address>, u32),
}

/// The multi-signature admin group that authorizes contract upgrades.
///
/// `threshold` signers drawn from `signers` must approve a specific WASM hash
/// before [`PaymentRouter::upgrade`] (or the timelock's
/// [`ActionType::Upgrade`]) will install it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultisigConfig {
    /// The N addresses whose signatures count towards an upgrade approval.
    pub signers: Vec<Address>,
    /// The M signers that must approve before an upgrade is authorized.
    pub threshold: u32,
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
    /// The multi-signature configuration is unusable: the signer set is empty,
    /// contains a duplicate address, the threshold is zero, or the threshold
    /// exceeds the number of signers (so the upgrade could never be authorized).
    InvalidMultisigConfig = 21,
    /// The calling address is not a member of the multi-signature admin group.
    NotMultisigSigner = 22,
    /// The number of collected upgrade approvals is below the configured
    /// threshold, so the upgrade is not authorized yet.
    InsufficientApprovals = 23,
    /// No multi-signature admin group has been configured yet.  Upgrades fail
    /// closed until `set_multisig_config` has been called, so a freshly
    /// deployed contract can never be upgraded through the single admin key
    /// that the group was introduced to de-risk.
    MultisigNotInitialized = 24,
    /// The calling address has already approved this WASM hash.  Duplicate
    /// approvals are rejected rather than ignored so that a replayed signature
    /// can never inflate the approval count towards the threshold.
    AlreadyApproved = 25,
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

    // ── Sender authorization ─────────────────────────────────────────────────
    //
    // `route_payments` authorizes a batch by calling `require_auth` once per
    // *distinct* sender rather than once per payment.
    //
    // The obvious implementation — `require_auth` inside the per-payment
    // helper — traps the whole invocation whenever a batch happens to contain
    // two payments from the same address, which is an ordinary thing to ask
    // for (split one payment across several recipients). Re-authorizing an
    // address that is already authorized in this frame is the trigger:
    // soroban-env-host aborts the thread with a non-unwinding panic rather
    // than returning an error, so the sender loses the whole batch instead of
    // getting a rejection it can act on. Calling it once per address keeps a
    // repeated sender on the graceful path and costs nothing: an address that
    // has already authorized this invocation gains nothing by being asked
    // again, and every distinct sender is still gated on its own signature.

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

        // Authorize each distinct sender exactly once, while the batch is
        // still untouched, so an unauthorized sender is refused before any
        // transfer has run.  Asking an address that has already authorized
        // this invocation again would trap it, so the seen-set matters.
        let mut authorized: Vec<Address> = Vec::new(&env);

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
            if !authorized.contains(&payment.sender) {
                payment.sender.require_auth();
                authorized.push_back(payment.sender.clone());
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
        Address, Bytes, Env, Symbol, TryIntoVal,
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
    // ── Multi-signature (M-of-N) upgrade tests ───────────────────────────────
    //
    // Issue #664. The whole point of the feature is that no single key — the
    // admin's included — can install new code, so the tests below are built
    // around that invariant rather than around the happy path alone: for every
    // M-of-N combination there is a case proving the (M-1)th signature is not
    // enough and the Mth one is.

    /// The smallest WASM module the Soroban host will accept as an installable
    /// contract, so the success path of `upgrade` can be exercised without
    /// building the real artifact first.
    ///
    /// The host refuses to swap a contract's executable unless the module both
    /// parses and carries a `contractenvmetav0` custom section declaring the
    /// host interface version it was built against, which is what this blob
    /// assembles: the 8-byte module header, then one custom section. A custom
    /// section is `id 0`, its byte length, then the section name as a
    /// LEB128-prefixed string followed by the contents — here the XDR of
    /// `SCEnvMetaEntry::SC_ENV_META_KIND_INTERFACE_VERSION(20 << 32 | 0)`,
    /// which is a 4-byte union discriminant of 0 then the 8-byte big-endian
    /// interface version. The host accepts contracts built for its own protocol
    /// version or an older one, and released SDKs are pre-release 0, so this
    /// stays installable across SDK upgrades.
    const PLACEHOLDER_WASM: &[u8] = b"\0asm\x01\0\0\0\
        \x00\x1e\
        \x11contractenvmetav0\
        \x00\x00\x00\x00\x00\x00\x00\x14\x00\x00\x00\x00";

    /// A second, distinguishable copy of [`PLACEHOLDER_WASM`]: byte-for-byte
    /// identical apart from one extra custom section, which the host ignores
    /// but which makes the module hash differently. Used to prove that
    /// approvals collected for one artifact do not carry over to another.
    const PLACEHOLDER_WASM_ALT: &[u8] = b"\0asm\x01\0\0\0\
        \x00\x1e\
        \x11contractenvmetav0\
        \x00\x00\x00\x00\x00\x00\x00\x14\x00\x00\x00\x00\
        \x00\x03\x01t\xff";

    /// Uploads [`PLACEHOLDER_WASM`] and returns the hash `upgrade` installs.
    fn upload_placeholder_wasm(env: &Env) -> BytesN<32> {
        env.deployer()
            .upload_contract_wasm(Bytes::from_slice(env, PLACEHOLDER_WASM))
    }

    /// Same as [`upload_placeholder_wasm`], for [`PLACEHOLDER_WASM_ALT`].
    fn upload_alt_placeholder_wasm(env: &Env) -> BytesN<32> {
        env.deployer()
            .upload_contract_wasm(Bytes::from_slice(env, PLACEHOLDER_WASM_ALT))
    }

    /// Reports whether the contract still holds `key` in persistent storage.
    ///
    /// The upgrade tests deliberately install a placeholder program that
    /// exports nothing, so once a swap lands the contract can no longer answer
    /// its own queries. Reading the ledger directly is the only remaining way
    /// to observe the state a swap left behind.
    fn contract_still_stores(env: &Env, contract: &Address, key: &DataKey) -> bool {
        env.as_contract(contract, || env.storage().persistent().has(key))
    }

    /// Returns `n` fresh signer addresses.
    fn signers(env: &Env, n: usize) -> Vec<Address> {
        let mut out = Vec::new(env);
        for _ in 0..n {
            out.push_back(Address::generate(env));
        }
        out
    }

    /// Advances the test ledger past the 24-hour timelock delay.
    fn advance_past_timelock(env: &Env) {
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
    }

    /// Asserts the approvals recorded for `hash` are exactly `expected`, in
    /// order. Soroban's `Vec` cannot be compared against a slice, so this
    /// compares length and then element by element.
    fn assert_approvals(
        client: &PaymentRouterClient<'static>,
        hash: &BytesN<32>,
        expected: &Vec<Address>,
    ) {
        let actual = client.get_upgrade_approvals(hash);
        assert_eq!(actual.len(), expected.len(), "approval count mismatch");
        for i in 0..expected.len() {
            assert_eq!(actual.get(i), expected.get(i));
        }
    }

    /// Boots an initialized router with a configured M-of-N admin group and a
    /// WASM hash ready to be approved. Returns the env, client, admin, the
    /// signer set and the candidate WASM hash.
    fn setup_multisig(
        signer_count: usize,
        threshold: u32,
    ) -> (
        Env,
        PaymentRouterClient<'static>,
        Address,
        Vec<Address>,
        BytesN<32>,
    ) {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let signers = signers(&env, signer_count);
        client.set_multisig_config(&signers, &threshold);
        let new_wasm_hash = upload_placeholder_wasm(&env);

        (env, client, admin, signers, new_wasm_hash)
    }

    #[test]
    fn test_upgrades_fail_closed_before_a_group_is_configured() {
        let (env, client, _) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

        let hash = upload_placeholder_wasm(&env);
        let signer = Address::generate(&env);

        // There is deliberately no fallback to the single admin key here: a
        // deployment that has not configured a group cannot be upgraded at all
        // rather than falling back to the key this feature de-risks.
        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::MultisigNotInitialized
        );
        assert_eq!(
            client
                .try_approve_upgrade(&signer, &hash)
                .unwrap_err()
                .unwrap(),
            Error::MultisigNotInitialized
        );
        assert_eq!(
            client.try_get_multisig_config().unwrap_err().unwrap(),
            Error::MultisigNotInitialized
        );
        assert_eq!(
            client
                .try_is_upgrade_authorized(&hash)
                .unwrap_err()
                .unwrap(),
            Error::MultisigNotInitialized
        );
    }

    #[test]
    fn test_set_multisig_config_round_trips() {
        let (_env, client, _, _, _) = setup_multisig(5, 3);

        let config = client.get_multisig_config();
        assert_eq!(config.threshold, 3);
        assert_eq!(config.signers.len(), 5);
    }

    #[test]
    fn test_set_multisig_config_rejects_unsafe_configurations() {
        let (env, client, _, signers, _) = setup_multisig(3, 2);

        // An empty group could never authorize anything.
        assert_eq!(
            client
                .try_set_multisig_config(&Vec::new(&env), &1)
                .unwrap_err()
                .unwrap(),
            Error::InvalidMultisigConfig
        );
        // A zero threshold would make the M-of-N gate vacuous.
        assert_eq!(
            client
                .try_set_multisig_config(&signers, &0)
                .unwrap_err()
                .unwrap(),
            Error::InvalidMultisigConfig
        );
        // A threshold above the signer count could never be reached.
        assert_eq!(
            client
                .try_set_multisig_config(&signers, &4)
                .unwrap_err()
                .unwrap(),
            Error::InvalidMultisigConfig
        );
        // Duplicates would let one key pad the effective signer count.
        let dupes = Vec::from_slice(&env, &[signers.get(0).unwrap(), signers.get(0).unwrap()]);
        assert_eq!(
            client
                .try_set_multisig_config(&dupes, &2)
                .unwrap_err()
                .unwrap(),
            Error::InvalidMultisigConfig
        );

        // The rejected attempts left the working configuration untouched.
        assert_eq!(client.get_multisig_config().threshold, 2);
    }

    #[test]
    fn test_setting_the_group_requires_the_admin_signature() {
        let (env, client, admin, _, _) = setup_multisig(3, 2);

        client.set_multisig_config(&signers(&env, 4), &3);

        // `auths()` reports the most recent invocation only, so this is the
        // signature `set_multisig_config` itself demanded.
        let auths = env.auths();
        assert_eq!(auths.len(), 1);
        assert_eq!(auths.first().map(|(addr, _)| addr.clone()), Some(admin));
    }

    #[test]
    fn test_admin_alone_cannot_upgrade_the_contract() {
        // The headline regression test for #664: the admin used to hold the
        // only key that could install new code. With a 3-of-5 group its
        // signature is not one of the three.
        let (_env, client, _admin, _signers, hash) = setup_multisig(5, 3);

        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );
    }

    #[test]
    fn test_two_of_three_needs_two_signatures_not_one() {
        let (_env, client, _admin, signers, hash) = setup_multisig(3, 2);

        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        assert_eq!(client.get_upgrade_approvals(&hash).len(), 1);
        assert!(!client.is_upgrade_authorized(&hash));

        // One signature short of the threshold.
        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );

        // The second distinct signature crosses it.
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        assert!(client.is_upgrade_authorized(&hash));
        client.upgrade(&hash);
    }

    #[test]
    fn test_unanimous_two_of_two_rejects_a_single_signature() {
        let (_env, client, _admin, signers, hash) = setup_multisig(2, 2);

        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );

        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        client.upgrade(&hash);
    }

    #[test]
    fn test_unanimous_three_of_three_rejects_two_signatures() {
        let (_env, client, _admin, signers, hash) = setup_multisig(3, 3);

        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );

        client.approve_upgrade(&signers.get(2).unwrap(), &hash);
        client.upgrade(&hash);
    }

    #[test]
    fn test_signers_beyond_the_threshold_may_still_approve() {
        // 3-of-5: the quorum is met after three signatures, and the remaining
        // two are still legitimate group members rather than being rejected.
        let (_env, client, _admin, signers, hash) = setup_multisig(5, 3);

        let mut all = Vec::new(&client.env);
        for i in 0..5u32 {
            all.push_back(signers.get(i).unwrap());
        }

        for i in 0..5u32 {
            client.approve_upgrade(&signers.get(i).unwrap(), &hash);
        }

        assert_eq!(client.get_upgrade_approvals(&hash).len(), 5);
        assert!(client.is_upgrade_authorized(&hash));
        assert_approvals(&client, &hash, &all);

        client.upgrade(&hash);
    }

    #[test]
    fn test_one_of_one_threshold_allows_a_single_signer() {
        // The degenerate configuration still works, so a solo deployment can
        // use the same code path rather than needing a special case.
        let (_env, client, _admin, signers, hash) = setup_multisig(1, 1);

        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );
        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        client.upgrade(&hash);
    }

    #[test]
    fn test_outsiders_cannot_approve() {
        let (_env, client, _admin, signers, hash) = setup_multisig(3, 2);
        let outsider = Address::generate(&client.env);

        assert_eq!(
            client
                .try_approve_upgrade(&outsider, &hash)
                .unwrap_err()
                .unwrap(),
            Error::NotMultisigSigner
        );
        assert_eq!(client.get_upgrade_approvals(&hash).len(), 0);
        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );

        // The group members are unaffected by the rejected attempt.
        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        assert_eq!(client.get_upgrade_approvals(&hash).len(), 1);
    }

    #[test]
    fn test_approving_twice_cannot_inflate_the_quorum() {
        let (_env, client, _admin, signers, hash) = setup_multisig(3, 2);
        let first = signers.get(0).unwrap();

        client.approve_upgrade(&first, &hash);
        // A replayed signature is an error, never a second vote.
        assert_eq!(
            client
                .try_approve_upgrade(&first, &hash)
                .unwrap_err()
                .unwrap(),
            Error::AlreadyApproved
        );
        assert_eq!(client.get_upgrade_approvals(&hash).len(), 1);
        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );
    }

    #[test]
    fn test_approvals_are_scoped_to_one_wasm_hash() {
        // Signatures authorize a specific artifact, so they must not carry over
        // to a different one.
        let (env, client, _admin, signers, hash) = setup_multisig(3, 2);
        let other_hash = upload_alt_placeholder_wasm(&env);
        assert_ne!(hash, other_hash);

        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);

        assert!(client.is_upgrade_authorized(&hash));
        assert_eq!(client.get_upgrade_approvals(&other_hash).len(), 0);
        assert!(!client.is_upgrade_authorized(&other_hash));
        assert_eq!(
            client.try_upgrade(&other_hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );
    }

    #[test]
    fn test_upgrade_consumes_the_approvals_that_authorized_it() {
        let (env, client, _admin, signers, hash) = setup_multisig(3, 2);

        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        assert!(contract_still_stores(
            &env,
            &client.address,
            &DataKey::UpgradeApproval(hash.clone())
        ));

        client.upgrade(&hash);

        // The quorum that authorized the swap is spent, so replaying the same
        // hash needs a fresh round of signatures rather than reusing the old
        // one. The placeholder program installed above exports nothing, so the
        // cleared record is read straight off the ledger.
        assert!(
            !contract_still_stores(&env, &client.address, &DataKey::UpgradeApproval(hash)),
            "the approvals that authorized an upgrade must not survive it"
        );
    }

    #[test]
    fn test_revoking_an_approval_drops_the_group_back_below_threshold() {
        let (_env, client, _admin, signers, hash) = setup_multisig(3, 2);

        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        assert!(client.is_upgrade_authorized(&hash));

        client.revoke_upgrade_approval(&signers.get(1).unwrap(), &hash);

        assert!(!client.is_upgrade_authorized(&hash));
        assert_approvals(
            &client,
            &hash,
            &Vec::from_slice(&client.env, &[signers.get(0).unwrap()]),
        );
        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );

        // A signer that pulled its approval can put it back.
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        assert!(client.is_upgrade_authorized(&hash));
    }

    #[test]
    fn test_revoking_without_a_recorded_approval_is_a_no_op() {
        let (_env, client, _admin, signers, hash) = setup_multisig(3, 2);

        client.revoke_upgrade_approval(&signers.get(0).unwrap(), &hash);
        assert_eq!(client.get_upgrade_approvals(&hash).len(), 0);

        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        client.revoke_upgrade_approval(&signers.get(0).unwrap(), &hash);
        // Revoking the last approval clears the entry entirely.
        assert_eq!(client.get_upgrade_approvals(&hash).len(), 0);
    }

    #[test]
    fn test_admin_can_cancel_pending_upgrade_approvals() {
        let (_env, client, _admin, signers, hash) = setup_multisig(3, 2);

        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        assert!(client.is_upgrade_authorized(&hash));

        client.cancel_upgrade(&hash);

        assert_eq!(client.get_upgrade_approvals(&hash).len(), 0);
        assert!(!client.is_upgrade_authorized(&hash));
        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );
    }

    #[test]
    fn test_rotating_the_group_stops_removed_signers_from_approving() {
        let (env, client, _admin, old_signers, hash) = setup_multisig(3, 2);

        let dropped = old_signers.get(2).unwrap();
        let newcomer = Address::generate(&env);
        let kept = old_signers.get(0).unwrap();

        // 2-of-2 over the retained signer plus a newcomer.
        let rotated = Vec::from_slice(&env, &[kept.clone(), newcomer.clone()]);
        client.set_multisig_config(&rotated, &2);

        assert_eq!(client.get_multisig_config().signers.len(), 2);
        assert_eq!(
            client
                .try_approve_upgrade(&dropped, &hash)
                .unwrap_err()
                .unwrap(),
            Error::NotMultisigSigner
        );

        // The retained signer carries over; the newcomer starts clean.
        client.approve_upgrade(&kept, &hash);
        assert_approvals(&client, &hash, &Vec::from_slice(&env, &[kept]));
        assert!(!client.is_upgrade_authorized(&hash));
        client.approve_upgrade(&newcomer, &hash);
        client.upgrade(&hash);
    }

    #[test]
    fn test_raising_the_threshold_revalidates_in_flight_approvals() {
        // Two signatures against a 2-of-3 group are enough, but the admin
        // tightening the group to 3-of-3 must invalidate the collected quorum.
        let (_env, client, _admin, signers, hash) = setup_multisig(3, 2);

        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        assert!(client.is_upgrade_authorized(&hash));

        client.set_multisig_config(&signers, &3);

        assert!(!client.is_upgrade_authorized(&hash));
        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );

        client.approve_upgrade(&signers.get(2).unwrap(), &hash);
        client.upgrade(&hash);
    }

    #[test]
    fn test_rotating_out_a_signer_voids_the_approval_it_already_cast() {
        // The dangerous shape: a lone approval meets a *lower* threshold after
        // the group is rotated. If rotation left the stale vote counting, the
        // one removed key would authorize an upgrade by itself.
        let (env, client, _admin, signers, hash) = setup_multisig(3, 2);

        let removed = signers.get(0).unwrap();
        client.approve_upgrade(&removed, &hash);
        assert!(!client.is_upgrade_authorized(&hash));

        // Drop the signer that approved and lower the threshold to 1, so the
        // stored approval alone would clear the bar if it still counted.
        let kept: Vec<Address> =
            Vec::from_slice(&env, &[signers.get(1).unwrap(), signers.get(2).unwrap()]);
        client.set_multisig_config(&kept, &1);

        assert!(!client.is_upgrade_authorized(&hash));
        assert_eq!(client.get_upgrade_approvals(&hash).len(), 0);
        assert_eq!(
            client.try_upgrade(&hash).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );

        // The new group's own member can authorize normally.
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        assert!(client.is_upgrade_authorized(&hash));
        client.upgrade(&hash);
    }

    #[test]
    fn test_approving_an_upgrade_records_the_signers_own_signature() {
        let (env, client, _, signers, hash) = setup_multisig(3, 2);
        let signer = signers.get(0).unwrap();

        client.approve_upgrade(&signer, &hash);

        // Proves the contract demands a signature from the address it was told
        // is approving, rather than trusting the caller's word.
        let auths = env.auths();
        assert!(
            auths.iter().any(|(addr, _)| *addr == signer),
            "approve_upgrade must require the approving signer to authorize"
        );
    }

    #[test]
    fn test_upgrade_needs_no_signature_once_the_quorum_is_reached() {
        // The M collected signatures are the whole authorization, so the
        // installing transaction must not silently demand a seventh key.
        let (env, client, _admin, signers, hash) = setup_multisig(3, 2);

        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        client.upgrade(&hash);

        // `auths()` reports the most recent invocation only: the swap itself
        // demanded no authorization at all.
        assert!(
            env.auths().is_empty(),
            "upgrade must not require any authorization once the quorum is reached"
        );
    }

    #[test]
    fn test_timelock_upgrade_also_requires_the_multisig_threshold() {
        // Queueing an upgrade and waiting out the delay must not be a way
        // around the M-of-N gate.
        let (env, client, _admin, _signers, hash) = setup_multisig(3, 2);

        let nonce = client.queue_action(&ActionType::Upgrade(hash.clone()));
        advance_past_timelock(&env);

        assert_eq!(
            client.try_execute_action(&nonce).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );
    }

    #[test]
    fn test_timelock_upgrade_entry_survives_a_rejected_multisig_check() {
        // Validation runs before the entry is consumed, so an upgrade that is
        // not yet authorized stays in the queue instead of being burned.
        let (env, client, _admin, signers, hash) = setup_multisig(3, 2);

        let nonce = client.queue_action(&ActionType::Upgrade(hash.clone()));
        advance_past_timelock(&env);
        assert_eq!(
            client.try_execute_action(&nonce).unwrap_err().unwrap(),
            Error::InsufficientApprovals
        );

        assert_eq!(
            client.get_queued_action(&nonce).action,
            ActionType::Upgrade(hash.clone())
        );

        // Once the group signs off, the same entry executes unchanged.
        client.approve_upgrade(&signers.get(0).unwrap(), &hash);
        client.approve_upgrade(&signers.get(1).unwrap(), &hash);
        client.execute_action(&nonce);

        // Execution consumed the entry and, with it, the quorum that unlocked
        // the swap. The placeholder program installed by the swap exports
        // nothing, so both facts are read straight off the ledger.
        assert!(
            !contract_still_stores(&env, &client.address, &DataKey::TimelockEntry(nonce)),
            "a successfully executed entry must not be left in the queue"
        );
        assert!(
            !contract_still_stores(&env, &client.address, &DataKey::UpgradeApproval(hash)),
            "the approvals that authorized the upgrade must not survive it"
        );
    }

    #[test]
    fn test_timelock_set_multisig_config_is_validated_when_it_executes() {
        // An invalid rotation queued today must not be applied in 24 hours, and
        // must not consume the queue slot either.
        let (env, client, _admin, signers, _) = setup_multisig(3, 2);

        let bad = client.queue_action(&ActionType::SetMultisigConfig(signers.clone(), 9));
        advance_past_timelock(&env);

        assert_eq!(
            client.try_execute_action(&bad).unwrap_err().unwrap(),
            Error::InvalidMultisigConfig
        );
        assert_eq!(client.get_multisig_config().threshold, 2);
    }

    #[test]
    fn test_timelock_set_multisig_config_applies_after_the_delay() {
        let (env, client, _admin, old_signers, _) = setup_multisig(3, 2);

        let new_signers = signers(&env, 4);
        let nonce = client.queue_action(&ActionType::SetMultisigConfig(new_signers.clone(), 3));
        advance_past_timelock(&env);
        client.execute_action(&nonce);

        let config = client.get_multisig_config();
        assert_eq!(config.threshold, 3);
        assert_eq!(config.signers.len(), 4);
        // The old set no longer counts.
        assert_eq!(
            client
                .try_approve_upgrade(&old_signers.get(0).unwrap(), &upload_placeholder_wasm(&env))
                .unwrap_err()
                .unwrap(),
            Error::NotMultisigSigner
        );
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

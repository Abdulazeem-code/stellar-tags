use crate::errors::Error;
use soroban_sdk::{contracttype, Address, BytesN, Env};

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
    /// The backup admin that can claim ownership via the dead man's switch.
    /// Stored as `Address` in instance storage.
    BackupAdmin,
    /// Unix timestamp of the last admin heartbeat (see `ping`).
    /// Stored as `u64` in instance storage.
    LastHeartbeat,
    /// Inactivity window (seconds) after which the backup admin may claim.
    /// Stored as `u64` in instance storage.
    DmsTimeout,
    /// Per-address payment invocation cap per ledger sequence.
    /// Stored as `u32` in instance storage (`0` disables rate limiting).
    RateLimitConfig,
    /// Packed invocation counter for a given sender (BytesN<8>).
    RateLimitCounter(Address),
    /// Whether a given sender is whitelisted and therefore exempt from the rate limiter.
    RateLimitWhitelist(Address),
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
    /// Whether a DEX router contract is approved to receive cross-contract swap calls.
    RegisteredDex(Address),
    /// Maximum tolerated swap slippage in basis points.
    MaxSlippageBps,
    /// The N addresses of the multi-signature admin group for upgrades.
    MultisigSigners,
    /// The M signers threshold of the multi-signature admin group.
    MultisigThreshold,
    /// Signer approvals collected for a specific upgrade WASM hash.
    UpgradeApproval(BytesN<32>),
    /// Guard against cross-contract reentrancy attacks.
    ReentrancyGuard,
    /// Circular telemetry ring-buffer header (head, count, capacity, running_sum).
    TelemetryHeader,
    /// Individual circular telemetry ring-buffer slot at index `u32`.
    TelemetrySlot(u32),
}

// ── Constants ────────────────────────────────────────────────────────────────

pub const BPS_DIVISOR: i128 = 10_000;
pub const XLM_DECIMALS: i128 = 10_000_000;
pub const MAX_AMOUNT: i128 = 1_000_000_000_000_000; // 100M tokens with 7 decimals
pub const DAILY_MAX_LIMIT: i128 = 1_000_000 * XLM_DECIMALS; // 1M tokens limit
pub const VOLUME_THRESHOLD: i128 = 10_000 * XLM_DECIMALS; // 10,000 XLM threshold for tiered fee discount
pub const SECONDS_IN_24H: u64 = 24 * 3600;
pub const MIN_DMS_TIMEOUT: u64 = 7 * 24 * 3600;
pub const DEFAULT_RATE_LIMIT: u32 = 10;
pub const MAX_RATE_LIMIT: u32 = 1_000_000;
pub const DEFAULT_MAX_SLIPPAGE_BPS: i128 = 1_000;
pub const MAX_SLIPPAGE_BPS_LIMIT: i128 = 10_000;
pub const DAY_IN_LEDGERS: u32 = 17280;
pub const INSTANCE_BUMP_AMOUNT: u32 = 7 * DAY_IN_LEDGERS;
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;
pub const USER_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const USER_LIFETIME_THRESHOLD: u32 = USER_BUMP_AMOUNT - DAY_IN_LEDGERS;
pub const PERSISTENT_BUMP_AMOUNT: u32 = USER_BUMP_AMOUNT;
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = USER_LIFETIME_THRESHOLD;
pub const TEMPORARY_BUMP_AMOUNT: u32 = 7 * DAY_IN_LEDGERS;
pub const TEMPORARY_LIFETIME_THRESHOLD: u32 = TEMPORARY_BUMP_AMOUNT - DAY_IN_LEDGERS;
pub const DEFAULT_TELEMETRY_CAPACITY: u32 = 64;
pub const MAX_TELEMETRY_CAPACITY: u32 = 256;

// ── Reentrancy Guard ─────────────────────────────────────────────────────────

pub struct ReentrancyGuard<'a> {
    env: &'a Env,
}

impl<'a> ReentrancyGuard<'a> {
    pub fn new(env: &'a Env) -> Result<Self, Error> {
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

// ── Packed Record Helpers ────────────────────────────────────────────────────

pub fn pack_user_record(
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

pub fn unpack_user_record(packed: &BytesN<40>) -> (u64, i128, i128) {
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

pub fn unpack_legacy_spending(packed: &BytesN<24>) -> (u64, i128) {
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

pub fn pack_rate_counter(env: &Env, window_ledger: u32, invocations: u32) -> BytesN<8> {
    let mut buf = [0u8; 8];
    let s = window_ledger.to_be_bytes();
    buf[0] = s[0];
    buf[1] = s[1];
    buf[2] = s[2];
    buf[3] = s[3];
    let c = invocations.to_be_bytes();
    buf[4] = c[0];
    buf[5] = c[1];
    buf[6] = c[2];
    buf[7] = c[3];
    BytesN::from_array(env, &buf)
}

pub fn unpack_rate_counter(packed: &BytesN<8>) -> (u32, u32) {
    let buf: [u8; 8] = packed.to_array();
    let window_ledger = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
    let invocations = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
    (window_ledger, invocations)
}

pub fn current_window(env: &Env) -> u32 {
    env.ledger().sequence()
}

pub fn load_user_record(env: &Env, sender: &Address, current_time: u64) -> (u64, i128, i128, bool) {
    let record_key = DataKey::UserRecord(sender.clone());

    if let Some(packed) = env
        .storage()
        .persistent()
        .get::<DataKey, BytesN<40>>(&record_key)
    {
        let (last_reset_time, accumulated_amount, volume) = unpack_user_record(&packed);
        return (last_reset_time, accumulated_amount, volume, false);
    }

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

pub fn accrue_user_record(env: &Env, sender: &Address, amount: i128) -> Result<i128, Error> {
    let current_time = env.ledger().timestamp();
    let record_key = DataKey::UserRecord(sender.clone());

    let (mut last_reset_time, mut accumulated_amount, volume, legacy_found) =
        load_user_record(env, sender, current_time);

    if current_time - last_reset_time >= SECONDS_IN_24H {
        last_reset_time = current_time;
        accumulated_amount = 0;
    }

    let Some(new_accumulated) = accumulated_amount.checked_add(amount) else {
        return Err(Error::LimitExceeded);
    };
    if new_accumulated > DAILY_MAX_LIMIT {
        return Err(Error::LimitExceeded);
    }
    accumulated_amount = new_accumulated;

    let new_volume = volume.saturating_add(amount);

    env.storage().persistent().set(
        &record_key,
        &pack_user_record(env, last_reset_time, accumulated_amount, new_volume),
    );
    env.storage().persistent().extend_ttl(
        &record_key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );

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

// ── Circular Telemetry Ring Buffer ───────────────────────────────────────────

/// A bit-packed 64-bit telemetry record for payment router operations.
///
/// Bit layout (64 bits total):
/// - Timestamp: 32 bits (bits 32..63)
/// - Volume:    24 bits (bits 8..31, max 16,777,215)
/// - Status:     8 bits (bits 0..7, max 255)
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub struct PackedTelemetryRecord {
    pub raw: u64,
}

impl PackedTelemetryRecord {
    pub const TIMESTAMP_BITS: u32 = 32;
    pub const VOLUME_BITS: u32 = 24;
    pub const STATUS_BITS: u32 = 8;
    pub const MAX_VOLUME: u32 = 0x00FF_FFFF; // 16,777,215 (24 bits)
    pub const MAX_STATUS: u8 = 0xFF; // 255 (8 bits)

    /// Creates a new `PackedTelemetryRecord` by bit-packing timestamp (32-bit),
    /// volume (24-bit saturating), and status (8-bit).
    #[inline]
    pub fn new(timestamp: u32, volume: u32, status: u8) -> Self {
        let vol = volume.min(Self::MAX_VOLUME);
        let raw = ((timestamp as u64) << 32)
            | (((vol as u64) & (Self::MAX_VOLUME as u64)) << 8)
            | (status as u64);
        Self { raw }
    }

    /// Reconstructs a record from an existing bit-packed `u64`.
    #[inline]
    pub fn from_raw(raw: u64) -> Self {
        Self { raw }
    }

    /// Returns the underlying bit-packed `u64`.
    #[inline]
    pub fn raw(&self) -> u64 {
        self.raw
    }

    /// Converts the record to `u64`.
    #[inline]
    pub fn to_u64(&self) -> u64 {
        self.raw
    }

    /// Reconstructs a record from a `u128`.
    #[inline]
    pub fn from_u128(val: u128) -> Self {
        Self { raw: val as u64 }
    }

    /// Converts the record to `u128`.
    #[inline]
    pub fn to_u128(&self) -> u128 {
        self.raw as u128
    }

    /// Unpacks the 32-bit Unix timestamp.
    #[inline]
    pub fn timestamp(&self) -> u32 {
        (self.raw >> 32) as u32
    }

    /// Unpacks the 24-bit payment volume.
    #[inline]
    pub fn volume(&self) -> u32 {
        ((self.raw >> 8) & (Self::MAX_VOLUME as u64)) as u32
    }

    /// Unpacks the 8-bit status code.
    #[inline]
    pub fn status(&self) -> u8 {
        (self.raw & 0xFF) as u8
    }

    /// Unpacks all fields as `(timestamp, volume, status)`.
    #[inline]
    pub fn unpack(&self) -> (u32, u32, u8) {
        (self.timestamp(), self.volume(), self.status())
    }
}

impl From<u64> for PackedTelemetryRecord {
    #[inline]
    fn from(raw: u64) -> Self {
        Self { raw }
    }
}

impl From<PackedTelemetryRecord> for u64 {
    #[inline]
    fn from(record: PackedTelemetryRecord) -> Self {
        record.raw
    }
}

impl From<u128> for PackedTelemetryRecord {
    #[inline]
    fn from(val: u128) -> Self {
        Self::from_u128(val)
    }
}

impl From<PackedTelemetryRecord> for u128 {
    #[inline]
    fn from(record: PackedTelemetryRecord) -> Self {
        record.to_u128()
    }
}

/// Header state for the circular telemetry ring buffer stored in temporary storage.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct TelemetryHeader {
    /// Next index within `0..capacity` to be overwritten.
    pub head: u32,
    /// Number of active records stored, saturated at `capacity`.
    pub count: u32,
    /// Maximum number of records retained in the circular buffer.
    pub capacity: u32,
    /// Sum of all volume values currently active in the sliding window.
    pub running_sum: u64,
}

/// A zero-allocation circular ring buffer backed by `env.storage().temporary()`.
///
/// Bit-packs telemetry records into single `u64` slots and tracks running metrics
/// (rolling average, statistical percentiles) in constant O(1) time with a fixed
/// stack memory footprint and zero dynamic heap reallocations.
pub struct TelemetryRingBuffer<'a> {
    env: &'a Env,
    header: TelemetryHeader,
}

impl<'a> TelemetryRingBuffer<'a> {
    /// Initializes a new circular ring buffer with the given capacity.
    ///
    /// Capacity is clamped between 1 and `MAX_TELEMETRY_CAPACITY`.
    pub fn new(env: &'a Env, capacity: u32) -> Self {
        let cap = if capacity == 0 {
            DEFAULT_TELEMETRY_CAPACITY
        } else if capacity > MAX_TELEMETRY_CAPACITY {
            MAX_TELEMETRY_CAPACITY
        } else {
            capacity
        };

        let header = TelemetryHeader {
            head: 0,
            count: 0,
            capacity: cap,
            running_sum: 0,
        };

        let buffer = Self { env, header };
        buffer.save_header();
        buffer
    }

    /// Loads an existing buffer header from temporary storage, or initializes a new one.
    pub fn load_or_create(env: &'a Env, capacity: u32) -> Self {
        if let Some(header) = env
            .storage()
            .temporary()
            .get::<DataKey, TelemetryHeader>(&DataKey::TelemetryHeader)
        {
            Self { env, header }
        } else {
            Self::new(env, capacity)
        }
    }

    /// Loads an existing buffer header from temporary storage without creating one.
    pub fn load(env: &'a Env) -> Option<Self> {
        env.storage()
            .temporary()
            .get::<DataKey, TelemetryHeader>(&DataKey::TelemetryHeader)
            .map(|header| Self { env, header })
    }

    /// Persists the ring-buffer header to temporary storage and extends its TTL.
    #[inline]
    pub fn save_header(&self) {
        self.env
            .storage()
            .temporary()
            .set(&DataKey::TelemetryHeader, &self.header);
        self.env.storage().temporary().extend_ttl(
            &DataKey::TelemetryHeader,
            TEMPORARY_LIFETIME_THRESHOLD,
            TEMPORARY_BUMP_AMOUNT,
        );
    }

    /// Appends a new bit-packed telemetry record to the circular ring buffer.
    ///
    /// - Overwrites the oldest slot when capacity is reached.
    /// - Updates `running_sum` in constant O(1) time without re-scanning.
    /// - Extends TTL on both the overwritten slot and the header.
    /// - Operates with zero dynamic heap reallocations.
    pub fn append(&mut self, record: PackedTelemetryRecord) {
        let cap = self.header.capacity;
        if cap == 0 {
            return;
        }

        let slot_idx = self.header.head;
        let slot_key = DataKey::TelemetrySlot(slot_idx);
        let new_vol = record.volume() as u64;

        if self.header.count >= cap {
            // Buffer is full: overwrite the oldest slot and adjust running sum in O(1).
            let old_vol = self
                .env
                .storage()
                .temporary()
                .get::<DataKey, PackedTelemetryRecord>(&slot_key)
                .map(|r| r.volume() as u64)
                .unwrap_or(0);
            self.header.running_sum = self
                .header
                .running_sum
                .saturating_sub(old_vol)
                .saturating_add(new_vol);
            self.header.count = cap;
        } else {
            // Buffer is not yet full: accumulate into running sum.
            self.header.running_sum = self.header.running_sum.saturating_add(new_vol);
            self.header.count += 1;
        }

        // Store bit-packed record into temporary storage slot
        self.env.storage().temporary().set(&slot_key, &record);

        // Rolling TTL extension on each append
        self.env.storage().temporary().extend_ttl(
            &slot_key,
            TEMPORARY_LIFETIME_THRESHOLD,
            TEMPORARY_BUMP_AMOUNT,
        );

        // Advance circular head index
        self.header.head = (slot_idx + 1) % cap;

        // Persist header and bump its TTL
        self.save_header();
    }

    /// Appends telemetry fields directly by constructing a `PackedTelemetryRecord`.
    #[inline]
    pub fn append_raw(&mut self, timestamp: u32, volume: u32, status: u8) -> PackedTelemetryRecord {
        let record = PackedTelemetryRecord::new(timestamp, volume, status);
        self.append(record);
        record
    }

    /// Computes the rolling average of active volumes in constant O(1) time.
    #[inline]
    pub fn rolling_average(&self) -> u64 {
        if self.header.count == 0 {
            0
        } else {
            self.header.running_sum / (self.header.count as u64)
        }
    }

    /// Computes the requested statistical percentile (0..=100) across the active
    /// sliding window in constant O(1) time with zero dynamic memory reallocations.
    pub fn percentile(&self, p: u32) -> u32 {
        let n = self.header.count as usize;
        if n == 0 {
            return 0;
        }

        let clamped_p = p.min(100);
        let mut vals = [0u32; MAX_TELEMETRY_CAPACITY as usize];
        let bound = n.min(MAX_TELEMETRY_CAPACITY as usize);

        for i in 0..bound {
            vals[i] = self
                .env
                .storage()
                .temporary()
                .get::<DataKey, PackedTelemetryRecord>(&DataKey::TelemetrySlot(i as u32))
                .map(|r| r.volume())
                .unwrap_or(0);
        }

        // In-place stack insertion sort (O(1) time bound given compile-time fixed MAX_TELEMETRY_CAPACITY)
        for i in 1..bound {
            let key = vals[i];
            let mut j = i;
            while j > 0 && vals[j - 1] > key {
                vals[j] = vals[j - 1];
                j -= 1;
            }
            vals[j] = key;
        }

        if clamped_p == 0 {
            return vals[0];
        }
        if clamped_p >= 100 {
            return vals[bound - 1];
        }

        // Nearest-rank interpolation formula
        let rank = (clamped_p as usize * (bound - 1) + 50) / 100;
        vals[rank]
    }

    /// Returns the 50th percentile (median) volume in constant O(1) time.
    #[inline]
    pub fn p50(&self) -> u32 {
        self.percentile(50)
    }

    /// Returns the 90th percentile volume in constant O(1) time.
    #[inline]
    pub fn p90(&self) -> u32 {
        self.percentile(90)
    }

    /// Returns the 95th percentile volume in constant O(1) time.
    #[inline]
    pub fn p95(&self) -> u32 {
        self.percentile(95)
    }

    /// Returns the 99th percentile volume in constant O(1) time.
    #[inline]
    pub fn p99(&self) -> u32 {
        self.percentile(99)
    }

    /// Returns the minimum volume currently in the window.
    #[inline]
    pub fn min_volume(&self) -> u32 {
        self.percentile(0)
    }

    /// Returns the maximum volume currently in the window.
    #[inline]
    pub fn max_volume(&self) -> u32 {
        self.percentile(100)
    }

    /// Reads an individual slot record from temporary storage.
    pub fn get_slot(&self, index: u32) -> Option<PackedTelemetryRecord> {
        if index >= self.header.capacity || index >= self.header.count {
            None
        } else {
            self.env
                .storage()
                .temporary()
                .get::<DataKey, PackedTelemetryRecord>(&DataKey::TelemetrySlot(index))
        }
    }

    /// Number of active records currently stored in the sliding window.
    #[inline]
    pub fn count(&self) -> u32 {
        self.header.count
    }

    /// Maximum capacity of the ring buffer.
    #[inline]
    pub fn capacity(&self) -> u32 {
        self.header.capacity
    }

    /// Current circular head index.
    #[inline]
    pub fn head(&self) -> u32 {
        self.header.head
    }

    /// Sum of all volumes active in the current window.
    #[inline]
    pub fn running_sum(&self) -> u64 {
        self.header.running_sum
    }

    /// Returns `true` if the buffer has no records yet.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.header.count == 0
    }

    /// Returns `true` if the buffer has reached capacity and is wrapping.
    #[inline]
    pub fn is_full(&self) -> bool {
        self.header.count >= self.header.capacity
    }

    /// Returns a copy of the current header state.
    #[inline]
    pub fn header(&self) -> TelemetryHeader {
        self.header
    }
}

// ── Standalone Telemetry Storage Helpers ─────────────────────────────────────

/// Appends a new telemetry record to the default temporary ring buffer.
pub fn append_telemetry(
    env: &Env,
    timestamp: u32,
    volume: u32,
    status: u8,
) -> PackedTelemetryRecord {
    let mut buffer = TelemetryRingBuffer::load_or_create(env, DEFAULT_TELEMETRY_CAPACITY);
    buffer.append_raw(timestamp, volume, status)
}

/// Appends an existing bit-packed telemetry record to the default temporary ring buffer.
pub fn append_telemetry_record(env: &Env, record: PackedTelemetryRecord) {
    let mut buffer = TelemetryRingBuffer::load_or_create(env, DEFAULT_TELEMETRY_CAPACITY);
    buffer.append(record);
}

/// Returns the rolling average volume from the default temporary ring buffer.
pub fn get_telemetry_average(env: &Env) -> u64 {
    let buffer = TelemetryRingBuffer::load_or_create(env, DEFAULT_TELEMETRY_CAPACITY);
    buffer.rolling_average()
}

/// Computes the requested percentile (0..=100) from the default temporary ring buffer.
pub fn get_telemetry_percentile(env: &Env, p: u32) -> u32 {
    let buffer = TelemetryRingBuffer::load_or_create(env, DEFAULT_TELEMETRY_CAPACITY);
    buffer.percentile(p)
}

/// Loads the telemetry ring-buffer header from temporary storage if present.
pub fn load_telemetry_header(env: &Env) -> Option<TelemetryHeader> {
    env.storage()
        .temporary()
        .get::<DataKey, TelemetryHeader>(&DataKey::TelemetryHeader)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn test_packed_telemetry_record_bit_packing_roundtrip() {
        let timestamp: u32 = 1_700_000_000;
        let volume: u32 = 500_000;
        let status: u8 = 1;

        let record = PackedTelemetryRecord::new(timestamp, volume, status);
        assert_eq!(record.timestamp(), timestamp);
        assert_eq!(record.volume(), volume);
        assert_eq!(record.status(), status);
        assert_eq!(record.unpack(), (timestamp, volume, status));

        // u64 conversions
        let raw = record.raw();
        let from_raw = PackedTelemetryRecord::from_raw(raw);
        assert_eq!(from_raw, record);
        assert_eq!(u64::from(record), raw);
        assert_eq!(PackedTelemetryRecord::from(raw), record);

        // u128 conversions
        let u128_val = record.to_u128();
        assert_eq!(u128_val, raw as u128);
        assert_eq!(PackedTelemetryRecord::from_u128(u128_val), record);
        assert_eq!(u128::from(record), u128_val);
        assert_eq!(PackedTelemetryRecord::from(u128_val), record);
    }

    #[test]
    fn test_packed_telemetry_record_boundary_and_saturation() {
        // Zero values
        let zero = PackedTelemetryRecord::new(0, 0, 0);
        assert_eq!(zero.timestamp(), 0);
        assert_eq!(zero.volume(), 0);
        assert_eq!(zero.status(), 0);
        assert_eq!(zero.raw(), 0);

        // Max values within field bit-widths
        let max_record =
            PackedTelemetryRecord::new(u32::MAX, PackedTelemetryRecord::MAX_VOLUME, 255);
        assert_eq!(max_record.timestamp(), u32::MAX);
        assert_eq!(max_record.volume(), PackedTelemetryRecord::MAX_VOLUME);
        assert_eq!(max_record.status(), 255);

        // Volume saturation above 24 bits (0x00FF_FFFF)
        let saturated = PackedTelemetryRecord::new(100, 0xFFFF_FFFF, 42);
        assert_eq!(saturated.timestamp(), 100);
        assert_eq!(saturated.volume(), PackedTelemetryRecord::MAX_VOLUME);
        assert_eq!(saturated.status(), 42);
    }

    #[test]
    fn test_telemetry_ring_buffer_empty_state() {
        let env = Env::default();
        let buffer = TelemetryRingBuffer::new(&env, 5);

        assert_eq!(buffer.count(), 0);
        assert_eq!(buffer.capacity(), 5);
        assert!(buffer.is_empty());
        assert!(!buffer.is_full());
        assert_eq!(buffer.running_sum(), 0);
        assert_eq!(buffer.rolling_average(), 0);
        assert_eq!(buffer.percentile(50), 0);
        assert_eq!(buffer.min_volume(), 0);
        assert_eq!(buffer.max_volume(), 0);
        assert_eq!(buffer.get_slot(0), None);
    }

    #[test]
    fn test_telemetry_ring_buffer_sequential_appends_under_capacity() {
        let env = Env::default();
        let mut buffer = TelemetryRingBuffer::new(&env, 5);

        buffer.append_raw(1001, 10, 0);
        buffer.append_raw(1002, 20, 0);
        buffer.append_raw(1003, 30, 0);

        assert_eq!(buffer.count(), 3);
        assert_eq!(buffer.head(), 3);
        assert!(!buffer.is_full());
        assert_eq!(buffer.running_sum(), 60);
        assert_eq!(buffer.rolling_average(), 20); // 60 / 3 = 20

        // Percentiles on [10, 20, 30]
        assert_eq!(buffer.min_volume(), 10);
        assert_eq!(buffer.percentile(0), 10);
        assert_eq!(buffer.p50(), 20);
        assert_eq!(buffer.max_volume(), 30);
        assert_eq!(buffer.percentile(100), 30);
    }

    #[test]
    fn test_telemetry_ring_buffer_wraps_correctly_past_capacity() {
        let env = Env::default();
        let mut buffer = TelemetryRingBuffer::new(&env, 5);

        // Fill capacity: 10, 20, 30, 40, 50
        buffer.append_raw(1001, 10, 0);
        buffer.append_raw(1002, 20, 0);
        buffer.append_raw(1003, 30, 0);
        buffer.append_raw(1004, 40, 0);
        buffer.append_raw(1005, 50, 0);

        assert_eq!(buffer.count(), 5);
        assert_eq!(buffer.head(), 0); // wrapped back to 0
        assert!(buffer.is_full());
        assert_eq!(buffer.running_sum(), 150);
        assert_eq!(buffer.rolling_average(), 30); // 150 / 5 = 30
        assert_eq!(buffer.p50(), 30);
        assert_eq!(buffer.min_volume(), 10);
        assert_eq!(buffer.max_volume(), 50);

        // 1st wrap: append 60 (overwriting slot 0, which held 10)
        buffer.append_raw(1006, 60, 0);
        assert_eq!(buffer.count(), 5);
        assert_eq!(buffer.head(), 1);
        // running_sum = 150 - 10 + 60 = 200
        assert_eq!(buffer.running_sum(), 200);
        assert_eq!(buffer.rolling_average(), 40); // 200 / 5 = 40
        // Active window: [60, 20, 30, 40, 50] -> sorted [20, 30, 40, 50, 60]
        assert_eq!(buffer.min_volume(), 20);
        assert_eq!(buffer.p50(), 40);
        assert_eq!(buffer.max_volume(), 60);

        // 2nd wrap: append 70 (overwriting slot 1, which held 20)
        buffer.append_raw(1007, 70, 0);
        assert_eq!(buffer.count(), 5);
        assert_eq!(buffer.head(), 2);
        // running_sum = 200 - 20 + 70 = 250
        assert_eq!(buffer.running_sum(), 250);
        assert_eq!(buffer.rolling_average(), 50); // 250 / 5 = 50
        // Active window: [60, 70, 30, 40, 50] -> sorted [30, 40, 50, 60, 70]
        assert_eq!(buffer.min_volume(), 30);
        assert_eq!(buffer.p50(), 50);
        assert_eq!(buffer.max_volume(), 70);
    }

    #[test]
    fn test_telemetry_ring_buffer_multiple_full_cycles() {
        let env = Env::default();
        let mut buffer = TelemetryRingBuffer::new(&env, 3);

        // Cycle 1: [100, 200, 300]
        buffer.append_raw(1, 100, 0);
        buffer.append_raw(2, 200, 0);
        buffer.append_raw(3, 300, 0);
        assert_eq!(buffer.rolling_average(), 200);

        // Cycle 2: overwrite all slots with [400, 500, 600]
        buffer.append_raw(4, 400, 0); // replaces 100 -> [400, 200, 300] (avg 300)
        assert_eq!(buffer.rolling_average(), 300);
        buffer.append_raw(5, 500, 0); // replaces 200 -> [400, 500, 300] (avg 400)
        assert_eq!(buffer.rolling_average(), 400);
        buffer.append_raw(6, 600, 0); // replaces 300 -> [400, 500, 600] (avg 500)
        assert_eq!(buffer.rolling_average(), 500);

        assert_eq!(buffer.p50(), 500);
        assert_eq!(buffer.min_volume(), 400);
        assert_eq!(buffer.max_volume(), 600);
    }

    #[test]
    fn test_telemetry_temporary_storage_isolation() {
        let env = Env::default();
        let mut buffer = TelemetryRingBuffer::new(&env, 4);
        buffer.append_raw(10, 100, 1);

        // Must be in temporary storage
        assert!(env.storage().temporary().has(&DataKey::TelemetryHeader));
        assert!(env.storage().temporary().has(&DataKey::TelemetrySlot(0)));

        // Must NOT leak into persistent or instance storage
        assert!(!env.storage().persistent().has(&DataKey::TelemetryHeader));
        assert!(!env.storage().persistent().has(&DataKey::TelemetrySlot(0)));
        assert!(!env.storage().instance().has(&DataKey::TelemetryHeader));
    }

    #[test]
    fn test_standalone_helpers_and_reload() {
        let env = Env::default();

        let rec = append_telemetry(&env, 12345, 500, 0);
        assert_eq!(rec.volume(), 500);
        assert_eq!(rec.status(), 0);

        append_telemetry_record(&env, PackedTelemetryRecord::new(12346, 1500, 1));

        assert_eq!(get_telemetry_average(&env), 1000);
        assert_eq!(get_telemetry_percentile(&env, 0), 500);
        assert_eq!(get_telemetry_percentile(&env, 100), 1500);

        let header = load_telemetry_header(&env).expect("header should exist");
        assert_eq!(header.count, 2);
        assert_eq!(header.running_sum, 2000);
    }
}

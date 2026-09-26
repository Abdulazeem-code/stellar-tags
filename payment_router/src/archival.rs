/// # Data Archival Module
///
/// ## Problem
/// Soroban persistent storage is rented: every ledger entry pays a state-rent
/// fee proportional to its size and the number of ledger periods it remains
/// live. `UserVolume` and `UserSpending` entries grow in proportion to unique
/// senders; `RefundBalance` entries persist until the sender claims them.
/// Over time this drives state-rent costs upward.
///
/// ## Solution — Merkle-root archival
///
/// Before removing a batch of old entries the admin commits a **SHA-256
/// Merkle root** of those entries into persistent contract storage, keyed by
/// an incrementing `ArchiveEpoch` counter. The off-chain indexer records the
/// full leaf data before the on-chain prune so that:
///
/// 1. Old entries can be **safely deleted** from contract state.
/// 2. The Merkle root **cryptographic proof** remains on-chain.
/// 3. Any third party can **verify** an off-chain record by reconstructing the
///    Merkle path and checking it against the stored root.
///
/// ## On-chain data model
///
/// ```text
/// DataKey::ArchiveEpoch          — u64  current epoch counter (instance)
/// DataKey::ArchiveRoot(epoch)    — BytesN<32>  Merkle root for epoch N
/// DataKey::ArchiveMeta(epoch)    — ArchiveMetadata  human-readable summary
/// ```
///
/// ## Off-chain leaf encoding (for Merkle proof reconstruction)
///
/// Each record type encodes deterministically so the off-chain verifier can
/// reproduce the exact same bytes without the Soroban SDK.
///
/// | Record type     | Tag    | Fields |
/// |-----------------|--------|--------|
/// | `UserVolume`    | `0x01` | address_strkey_bytes (56 B) + volume i128 BE (16 B) |
/// | `UserSpending`  | `0x02` | address_strkey_bytes (56 B) + packed BytesN<24> (24 B) |
/// | `RefundBalance` | `0x03` | user_strkey_bytes (56 B) + token_strkey_bytes (56 B) + balance i128 BE (16 B) |
///
/// `address_strkey_bytes` is the UTF-8 bytes of the G.../C... strkey string,
/// which is always exactly 56 ASCII characters for a Stellar address.

use soroban_sdk::{contracttype, Address, BytesN, Env, String, Symbol};

// ─── Archive types exposed to lib.rs ────────────────────────────────────────

/// Metadata stored alongside each archive root.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchiveMetadata {
    /// Unix timestamp (seconds) when this archive epoch was committed.
    pub committed_at: u64,
    /// Total number of leaf records included in this archive.
    pub record_count: u32,
    /// Free-form description tag (e.g. `"user_volume:2026-09"`).
    pub description: String,
}

/// Record types supported by the archival system.
///
/// The `repr(u32)` discriminant doubles as the tag byte prepended when
/// computing leaf hashes off-chain.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ArchiveRecordType {
    /// `DataKey::UserVolume(address)` — cumulative lifetime routed volume.
    UserVolume = 1,
    /// `DataKey::UserSpending(address)` — packed 24-hour spending window.
    UserSpending = 2,
    /// `DataKey::RefundBalance(user, token)` — unclaimed refund balance.
    RefundBalance = 3,
}

/// A single archive leaf descriptor passed into `commit_archive_root` and
/// `prune_archived_entries`.
///
/// The contract uses `record_type + primary_key (+ secondary_key)` to locate
/// the corresponding `DataKey` to delete during a prune. It does not re-hash
/// the leaves — the Merkle root is computed and trusted from off-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchiveLeaf {
    /// Which type of record this leaf represents.
    pub record_type: ArchiveRecordType,
    /// Primary key address:
    /// - `UserVolume` / `UserSpending`: the sender address.
    /// - `RefundBalance`: the user (sender) address.
    pub primary_key: Address,
    /// Secondary key address:
    /// - `RefundBalance`: the token contract address.
    /// - Other types: ignored (may be any address).
    pub secondary_key: Address,
}

// ─── Event helper ────────────────────────────────────────────────────────────

/// Emits an `archive_committed` event so off-chain indexers can track epochs.
///
/// Topics: `("archive_committed", epoch)`
/// Data:   `(root, record_count, committed_at)`
pub fn emit_archive_committed(env: &Env, epoch: u64, root: &BytesN<32>, record_count: u32) {
    env.events().publish(
        (Symbol::new(env, "archive_committed"), epoch),
        (root.clone(), record_count, env.ledger().timestamp()),
    );
}

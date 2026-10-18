# Data Archival Strategy — Issue #667

Storing all historical payment data on-chain indefinitely is expensive under
Soroban's state-rent model. This document describes the two-phase
**commit-then-prune** strategy that satisfies all acceptance criteria:

- Old records can be safely deleted from contract state.
- Cryptographic proofs (Merkle roots) are maintained on-chain.
- A mechanism exists to verify off-chain data against on-chain roots.

---

## Which state grows unboundedly

| `DataKey`                        | Grows with…                        |
|----------------------------------|------------------------------------|
| `UserVolume(Address)`            | Every unique sender address        |
| `UserSpending(Address)`          | Every unique sender address        |
| `RefundBalance(Address, Address)`| Unclaimed refund balances          |

Config keys (`Admin`, `FeeBps`, …) and timelock entries are bounded by design.

---

## On-chain data model (new keys)

```
DataKey::ArchiveEpoch          u64   — current epoch counter (instance storage)
DataKey::ArchiveRoot(epoch)    BytesN<32>  — SHA-256 Merkle root (persistent)
DataKey::ArchiveMeta(epoch)    ArchiveMetadata  — record_count, committed_at, description
```

Roots and metadata are stored in **persistent storage** with the same TTL bump
as other persistent entries (`USER_BUMP_AMOUNT = 30 × DAY_IN_LEDGERS`), so
they survive instance eviction.

---

## Off-chain database model (new tables)

```
archive_epochs   — one row per on-chain epoch
archive_leaves   — one row per archived record (leaf hash + value snapshot)
```

See `prisma/migrations/20260926000000_add_archive_epochs/migration.sql` and
`prisma/schema.prisma` (`ArchiveEpoch`, `ArchiveLeaf` models).

---

## Workflow

### Phase 1 — Snapshot & commit

```
Off-chain archival service                     Contract (on-chain)
─────────────────────────────                  ─────────────────────
1. Read target on-chain entries
   (UserVolume, UserSpending, …)
2. Build canonical leaf bytes per
   the encoding spec below
3. Compute SHA-256 Merkle root
4. Persist epoch + leaves to DB  ──────────>  5. commit_archive_root(root, leaves, desc)
                                                  stores root + metadata, emits
                                                  archive_committed event, returns epoch
```

### Phase 2 — Prune

```
6. Call prune_archived_entries(epoch, leaves)
   Contract verifies root exists for epoch,
   deletes matching DataKey entries,
   emits entries_pruned event, returns count
```

After phase 2 the on-chain storage entries are gone but the Merkle root
remains as permanent proof.

---

## Leaf encoding

Each record type encodes into a deterministic byte string.  Both the Rust
contract (`payment_router/src/archival.rs`) and the Node.js service
(`stellar-payment-platform/src/services/archivalService.js`) use the **same
layout**, so either side can reproduce any leaf.

### `UserVolume` — tag `0x01`

| Offset | Length | Content |
|--------|--------|---------|
| 0 | 1 | Tag: `0x01` |
| 1 | 56 | Address strkey (ASCII, e.g. `GABC…`) |
| 57 | 16 | Volume as `i128` big-endian |

**Total: 73 bytes**

### `UserSpending` — tag `0x02`

| Offset | Length | Content |
|--------|--------|---------|
| 0 | 1 | Tag: `0x02` |
| 1 | 56 | Address strkey |
| 57 | 24 | Packed `BytesN<24>`: bytes 0–7 = `last_reset_time` (u64 BE), bytes 8–23 = `accumulated_amount` (i128 BE) |

**Total: 81 bytes**

### `RefundBalance` — tag `0x03`

| Offset | Length | Content |
|--------|--------|---------|
| 0 | 1 | Tag: `0x03` |
| 1 | 56 | User address strkey |
| 57 | 56 | Token contract strkey |
| 113 | 16 | Balance as `i128` big-endian |

**Total: 129 bytes**

---

## Merkle tree construction

```
leaf_hash      = SHA-256( canonical_leaf_bytes )
internal_hash  = SHA-256( min(left, right) || max(left, right) )
```

- Pairs are **sorted** (smaller hash first) so the root is the same regardless
  of insertion order.
- Odd-length layers duplicate the last element.
- An empty leaf set produces a root of 32 zero bytes.

---

## Verification

### Off-chain (DB-only, fast path)

```js
const { verifyArchivedLeaf } = require('./src/services/archivalService');

const { valid, dbRoot, onChainRoot } = await verifyArchivedLeaf({
  epochNumber: 3n,
  leafHash: '…hex…',
  contractClient,          // used only for cross-check; works without it too
});
```

`verifyArchivedLeaf`:
1. Loads the epoch's leaf hashes from `archive_leaves`.
2. Rebuilds the Merkle proof from the stored hashes.
3. Verifies the proof against the DB root.
4. Optionally fetches the on-chain root via `get_archive_info` to cross-check.

### Manual (step-by-step)

```js
const { buildMerkleProof, verifyMerkleProof } = require('./src/services/archivalService');

// 1. Re-encode the leaf you want to verify.
const leafBytes = encodeUserVolumeLeaf('GABC…', 1_000_000n);
const leafHash  = crypto.createHash('sha256').update(leafBytes).digest('hex');

// 2. Fetch sibling hashes from the DB for the epoch.
const siblings = await prisma.archiveLeaf.findMany({ where: { epochId } });
const proof    = buildMerkleProof(siblings.map(s => Buffer.from(s.leafHash, 'hex')), index);

// 3. Fetch the on-chain root.
const [root] = await contractClient.get_archive_info({ epoch: 3n });
const rootHex = Buffer.from(root).toString('hex');

// 4. Verify.
const ok = verifyMerkleProof(leafHash, proof, rootHex);
```

---

## New contract methods

| Method | Auth | Description |
|--------|------|-------------|
| `commit_archive_root(root, leaves, description)` | TreasuryManager | Opens a new epoch; stores Merkle root + metadata |
| `prune_archived_entries(committed_epoch, leaves)` | TreasuryManager | Deletes on-chain entries for a committed epoch |
| `get_archive_info(epoch)` | — | Returns `(root, metadata)` or `None` |
| `get_archive_epoch()` | — | Returns current epoch counter |

---

## New contract events

| Symbol | Topics | Data |
|--------|--------|------|
| `archive_committed` | `(epoch: u64)` | `(root: BytesN<32>, record_count: u32, committed_at: u64)` |
| `entries_pruned` | `(epoch: u64)` | `(removed: u32, timestamp: u64)` |

---

## Security notes

- Only `TreasuryManager` can commit or prune, preventing a lower-privilege key
  from erasing historical proofs.
- The contract guards every `prune_archived_entries` call: if no root exists
  for the given epoch, the call returns `TimelockNotFound` and nothing is
  deleted.
- Pruning is blocked while the contract is frozen (`ContractFrozen`).
- The off-chain service is **idempotent**: committing the same Merkle root
  twice skips the contract call and returns the existing epoch record.
- Absent entries (already expired or never written) are skipped silently so
  partial expiry does not block batch cleanup.

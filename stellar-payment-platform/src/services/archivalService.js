/**
 * archivalService.js
 *
 * Off-chain component for issue #667 — Data Archival Strategy.
 *
 * Implements the two-phase commit+prune workflow:
 *
 *   Phase 1 – snapshot & commit
 *     1. Receive the on-chain entry snapshots from the caller.
 *     2. Build canonical leaf bytes and compute a SHA-256 Merkle root.
 *     3. Persist the epoch + leaves to the off-chain DB.
 *     4. Call commit_archive_root on the contract.
 *
 *   Phase 2 – prune
 *     5. Call prune_archived_entries on the contract using the committed epoch.
 *        The contract verifies the root exists before deleting anything.
 *
 * Leaf encoding (mirrors archival.rs exactly):
 *
 *   UserVolume    tag(0x01) | strkey(56 B) | i128_be(16 B)
 *   UserSpending  tag(0x02) | strkey(56 B) | packed24(24 B)
 *   RefundBalance tag(0x03) | user_strkey(56 B) | token_strkey(56 B) | i128_be(16 B)
 *
 * strkey is the ASCII bytes of the G.../C... base-32 address (always 56 chars).
 */

'use strict';

const crypto = require('crypto');
const { prisma } = require('../../prismaClient');
const { logger } = require('../../src/logger');

// ── Record types ──────────────────────────────────────────────────────────────

const RECORD_TYPES = Object.freeze({
  USER_VOLUME: 'UserVolume',
  USER_SPENDING: 'UserSpending',
  REFUND_BALANCE: 'RefundBalance',
});

const LEAF_TAGS = Object.freeze({
  UserVolume: 0x01,
  UserSpending: 0x02,
  RefundBalance: 0x03,
});

// ── Leaf encoding ─────────────────────────────────────────────────────────────

/**
 * Encodes a Stellar strkey address as a fixed 56-byte ASCII Buffer.
 * @param {string} address  G.../C... strkey (exactly 56 chars)
 * @returns {Buffer}
 */
function encodeAddress(address) {
  if (typeof address !== 'string' || address.length !== 56) {
    throw new Error(`Invalid Stellar address (expected 56 chars): "${address}"`);
  }
  return Buffer.from(address, 'ascii');
}

/**
 * Encodes a signed 128-bit integer (BigInt) as a 16-byte big-endian Buffer.
 * @param {BigInt} value
 * @returns {Buffer}
 */
function encodeI128(value) {
  const buf = Buffer.alloc(16);
  // Two's-complement 128-bit big-endian.
  const unsigned =
    ((BigInt(value) % (1n << 128n)) + (1n << 128n)) % (1n << 128n);
  buf.writeBigUInt64BE(unsigned >> 64n, 0);
  buf.writeBigUInt64BE(unsigned & 0xffffffffffffffffn, 8);
  return buf;
}

/**
 * Builds canonical leaf bytes for a UserVolume record.
 * @param {string} address
 * @param {BigInt} volume
 * @returns {Buffer}  73 bytes
 */
function encodeUserVolumeLeaf(address, volume) {
  return Buffer.concat([
    Buffer.from([LEAF_TAGS.UserVolume]),
    encodeAddress(address),
    encodeI128(volume),
  ]);
}

/**
 * Builds canonical leaf bytes for a UserSpending record.
 * @param {string} address
 * @param {Buffer} packed24  24-byte packed spending window
 * @returns {Buffer}  81 bytes
 */
function encodeUserSpendingLeaf(address, packed24) {
  if (!Buffer.isBuffer(packed24) || packed24.length !== 24) {
    throw new Error('packed24 must be a 24-byte Buffer');
  }
  return Buffer.concat([
    Buffer.from([LEAF_TAGS.UserSpending]),
    encodeAddress(address),
    packed24,
  ]);
}

/**
 * Builds canonical leaf bytes for a RefundBalance record.
 * @param {string} user
 * @param {string} token
 * @param {BigInt} balance
 * @returns {Buffer}  129 bytes
 */
function encodeRefundBalanceLeaf(user, token, balance) {
  return Buffer.concat([
    Buffer.from([LEAF_TAGS.RefundBalance]),
    encodeAddress(user),
    encodeAddress(token),
    encodeI128(balance),
  ]);
}

// ── SHA-256 ───────────────────────────────────────────────────────────────────

/** @param {Buffer} data @returns {Buffer} */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

// ── Merkle tree ───────────────────────────────────────────────────────────────

/**
 * Builds a Merkle tree from raw leaf Buffers and returns the root.
 *
 * - Leaves are individually sha256-hashed.
 * - Internal nodes: sha256( sort(left, right) ) — smaller hash first for
 *   canonical ordering regardless of insertion order.
 * - Odd-length layers duplicate the last element.
 * - Empty input → 32-byte zero root.
 *
 * @param {Buffer[]} leaves  Canonical leaf bytes (not yet hashed)
 * @returns {{ root: Buffer, leafHashes: string[] }}
 */
function buildMerkleTree(leaves) {
  if (leaves.length === 0) {
    return { root: Buffer.alloc(32), leafHashes: [] };
  }
  let layer = leaves.map((l) => sha256(l));
  const leafHashes = layer.map((h) => h.toString('hex'));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] ?? layer[i];
      const pair =
        Buffer.compare(left, right) <= 0
          ? Buffer.concat([left, right])
          : Buffer.concat([right, left]);
      next.push(sha256(pair));
    }
    layer = next;
  }
  return { root: layer[0], leafHashes };
}

/**
 * Builds a Merkle inclusion proof for the leaf at `index`.
 * @param {Buffer[]} leaves  Canonical leaf bytes
 * @param {number}   index
 * @returns {string[]}  Hex-encoded sibling hashes (bottom-up)
 */
function buildMerkleProof(leaves, index) {
  if (leaves.length === 0) return [];
  let layer = leaves.map((l) => sha256(l));
  return _buildProofFromHashedLayer(layer, index);
}

/**
 * Internal: build proof from an already-hashed layer.
 * @param {Buffer[]} layer
 * @param {number}   index
 * @returns {string[]}
 */
function _buildProofFromHashedLayer(layer, index) {
  const proof = [];
  let idx = index;
  while (layer.length > 1) {
    const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    const sibling = layer[sibIdx] ?? layer[idx];
    proof.push(sibling.toString('hex'));
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const l = layer[i];
      const r = layer[i + 1] ?? layer[i];
      const pair =
        Buffer.compare(l, r) <= 0
          ? Buffer.concat([l, r])
          : Buffer.concat([r, l]);
      next.push(sha256(pair));
    }
    layer = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Verifies a Merkle inclusion proof.
 * @param {string}   leafHash  Hex-encoded SHA-256 of the canonical leaf bytes
 * @param {string[]} proof     Sibling hashes from buildMerkleProof (bottom-up)
 * @param {string}   root      Hex-encoded 32-byte Merkle root
 * @returns {boolean}
 */
function verifyMerkleProof(leafHash, proof, root) {
  let current = Buffer.from(leafHash, 'hex');
  for (const sibHex of proof) {
    const sib = Buffer.from(sibHex, 'hex');
    const pair =
      Buffer.compare(current, sib) <= 0
        ? Buffer.concat([current, sib])
        : Buffer.concat([sib, current]);
    current = sha256(pair);
  }
  return current.toString('hex') === root;
}

// ── Phase 1: commit ───────────────────────────────────────────────────────────

/**
 * Reads on-chain entry snapshots, builds the Merkle root, persists to DB,
 * and calls commit_archive_root on the contract.
 *
 * @param {object}   opts
 * @param {object}   opts.contractClient  Instantiated Soroban contract client
 * @param {object[]} opts.entries         Array of entry snapshots:
 *   { recordType, primaryKey, secondaryKey?, value: { volume?, packed24?, balance? } }
 * @param {string}   opts.description     Free-form label, e.g. "user_volume:2026-09"
 * @returns {Promise<{ epochNumber: bigint, merkleRoot: string, dbEpochId: string }>}
 */
async function commitArchiveEpoch({ contractClient, entries, description }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('entries must be a non-empty array');
  }

  // 1. Build canonical leaf bytes.
  const leafBuffers = entries.map((entry) => {
    switch (entry.recordType) {
      case RECORD_TYPES.USER_VOLUME:
        return encodeUserVolumeLeaf(entry.primaryKey, entry.value.volume);
      case RECORD_TYPES.USER_SPENDING:
        return encodeUserSpendingLeaf(entry.primaryKey, entry.value.packed24);
      case RECORD_TYPES.REFUND_BALANCE:
        return encodeRefundBalanceLeaf(
          entry.primaryKey,
          entry.secondaryKey,
          entry.value.balance
        );
      default:
        throw new Error(`Unknown record type: ${entry.recordType}`);
    }
  });

  // 2. Compute Merkle root.
  const { root, leafHashes } = buildMerkleTree(leafBuffers);
  const merkleRootHex = root.toString('hex');

  logger.info('Archival: computed Merkle root', {
    merkleRoot: merkleRootHex,
    recordCount: entries.length,
    description,
  });

  // 3. Idempotency guard — skip if the same root was already committed.
  const existing = await prisma.archiveEpoch.findFirst({
    where: { merkleRoot: merkleRootHex },
  });
  if (existing) {
    logger.warn('Archival: root already committed, skipping duplicate', {
      epoch: existing.epoch.toString(),
      merkleRoot: merkleRootHex,
    });
    return {
      epochNumber: existing.epoch,
      merkleRoot: merkleRootHex,
      dbEpochId: existing.id,
    };
  }

  // 4. Call commit_archive_root on the contract.
  const contractLeaves = entries.map((entry) => ({
    record_type: entry.recordType,
    primary_key: entry.primaryKey,
    secondary_key: entry.secondaryKey ?? entry.primaryKey,
  }));
  const rootBytes = Array.from(root);

  const epochNumber = await contractClient.commit_archive_root({
    root: rootBytes,
    leaves: contractLeaves,
    description,
  });

  logger.info('Archival: on-chain commit succeeded', {
    epochNumber: epochNumber.toString(),
    merkleRoot: merkleRootHex,
  });

  // 5. Persist epoch + leaves to DB.
  const dbEpoch = await prisma.archiveEpoch.create({
    data: {
      epoch: epochNumber,
      merkleRoot: merkleRootHex,
      recordCount: entries.length,
      description,
      leaves: {
        create: entries.map((entry, i) => ({
          recordType: entry.recordType,
          primaryKey: entry.primaryKey,
          secondaryKey: entry.secondaryKey ?? null,
          leafHash: leafHashes[i],
          valueJson: entry.value ?? null,
        })),
      },
    },
  });

  return { epochNumber, merkleRoot: merkleRootHex, dbEpochId: dbEpoch.id };
}

// ── Phase 2: prune ────────────────────────────────────────────────────────────

/**
 * Calls prune_archived_entries on the contract for a previously committed epoch.
 *
 * @param {object} opts
 * @param {object} opts.contractClient
 * @param {bigint} opts.epochNumber  The epoch returned by commitArchiveEpoch
 * @returns {Promise<{ removed: number }>}
 */
async function pruneArchivedEntries({ contractClient, epochNumber }) {
  const dbEpoch = await prisma.archiveEpoch.findUnique({
    where: { epoch: epochNumber },
    include: { leaves: true },
  });
  if (!dbEpoch) {
    throw new Error(
      `No DB record for archive epoch ${epochNumber}. Was commitArchiveEpoch called?`
    );
  }

  const contractLeaves = dbEpoch.leaves.map((l) => ({
    record_type: l.recordType,
    primary_key: l.primaryKey,
    secondary_key: l.secondaryKey ?? l.primaryKey,
  }));

  const removed = await contractClient.prune_archived_entries({
    committed_epoch: epochNumber,
    leaves: contractLeaves,
  });

  logger.info('Archival: on-chain prune succeeded', {
    epochNumber: epochNumber.toString(),
    removed,
  });
  return { removed };
}

// ── Verification ──────────────────────────────────────────────────────────────

/**
 * Verifies that an archived leaf is included in the on-chain Merkle root.
 *
 * Pure off-chain using DB leaf hashes; the RPC is only called to cross-check
 * the stored root matches the DB root.
 *
 * @param {object} opts
 * @param {bigint}  opts.epochNumber
 * @param {string}  opts.leafHash     Hex-encoded SHA-256 of the canonical leaf bytes
 * @param {object}  opts.contractClient
 * @returns {Promise<{ valid: boolean, onChainRoot: string|null, dbRoot: string|null }>}
 */
async function verifyArchivedLeaf({ epochNumber, leafHash, contractClient }) {
  const dbEpoch = await prisma.archiveEpoch.findUnique({
    where: { epoch: epochNumber },
    include: { leaves: { select: { leafHash: true } } },
  });
  if (!dbEpoch) {
    return { valid: false, onChainRoot: null, dbRoot: null };
  }

  const leafIndex = dbEpoch.leaves.findIndex((l) => l.leafHash === leafHash);
  if (leafIndex === -1) {
    return { valid: false, onChainRoot: null, dbRoot: dbEpoch.merkleRoot };
  }

  // Rebuild proof from pre-hashed leaf hashes stored in DB.
  const hashedLayer = dbEpoch.leaves.map((l) => Buffer.from(l.leafHash, 'hex'));
  const proof = _buildProofFromHashedLayer(hashedLayer, leafIndex);
  const dbValid = verifyMerkleProof(leafHash, proof, dbEpoch.merkleRoot);

  // Cross-check with on-chain root (best-effort).
  let onChainRoot = null;
  try {
    const info = await contractClient.get_archive_info({ epoch: epochNumber });
    if (info) {
      onChainRoot = Buffer.from(info[0]).toString('hex');
    }
  } catch (err) {
    logger.warn('Archival: could not fetch on-chain root', {
      epochNumber: epochNumber.toString(),
      error: err.message,
    });
  }

  const valid =
    dbValid && (onChainRoot === null || onChainRoot === dbEpoch.merkleRoot);

  return { valid, onChainRoot, dbRoot: dbEpoch.merkleRoot };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  RECORD_TYPES,
  LEAF_TAGS,
  encodeAddress,
  encodeI128,
  encodeUserVolumeLeaf,
  encodeUserSpendingLeaf,
  encodeRefundBalanceLeaf,
  buildMerkleTree,
  buildMerkleProof,
  verifyMerkleProof,
  commitArchiveEpoch,
  pruneArchivedEntries,
  verifyArchivedLeaf,
};

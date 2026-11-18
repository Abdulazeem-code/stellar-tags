'use strict';

/**
 * Tests for the off-chain archival service (issue #667).
 *
 * All DB calls are mocked; the contract client is a lightweight stub.
 * Tests are self-contained and do not require a running Postgres instance.
 */

jest.mock('../prismaClient', () => ({
  prisma: {
    archiveEpoch: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { prisma } = require('../prismaClient');

const {
  RECORD_TYPES,
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
} = require('../src/services/archivalService');

// ── Leaf encoding ─────────────────────────────────────────────────────────────

describe('encodeAddress', () => {
  it('returns a 56-byte Buffer for a valid G address', () => {
    const addr = 'G' + 'A'.repeat(55);
    const buf = encodeAddress(addr);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(56);
    expect(buf.toString('ascii')).toBe(addr);
  });

  it('throws when address is not 56 chars', () => {
    expect(() => encodeAddress('GABC')).toThrow(/expected 56 chars/);
  });
});

describe('encodeI128', () => {
  it('encodes 0 as 16 zero bytes', () => {
    const buf = encodeI128(0n);
    expect(buf.length).toBe(16);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('encodes 1 correctly (big-endian)', () => {
    const buf = encodeI128(1n);
    // All zero except last byte
    expect(buf.readBigUInt64BE(0)).toBe(0n);
    expect(buf.readBigUInt64BE(8)).toBe(1n);
  });

  it('encodes a large positive value', () => {
    const val = 1_000_000_000_000_000n;
    const buf = encodeI128(val);
    const hi = buf.readBigUInt64BE(0);
    const lo = buf.readBigUInt64BE(8);
    expect(hi << 64n | lo).toBe(val);
  });
});

describe('encodeUserVolumeLeaf', () => {
  const addr = 'G' + 'B'.repeat(55);

  it('produces 73 bytes with tag 0x01', () => {
    const buf = encodeUserVolumeLeaf(addr, 500n);
    expect(buf.length).toBe(73);
    expect(buf[0]).toBe(0x01);
  });

  it('is deterministic for the same inputs', () => {
    const a = encodeUserVolumeLeaf(addr, 42n);
    const b = encodeUserVolumeLeaf(addr, 42n);
    expect(a.equals(b)).toBe(true);
  });

  it('differs for different volumes', () => {
    const a = encodeUserVolumeLeaf(addr, 1n);
    const b = encodeUserVolumeLeaf(addr, 2n);
    expect(a.equals(b)).toBe(false);
  });
});

describe('encodeUserSpendingLeaf', () => {
  const addr = 'G' + 'C'.repeat(55);
  const packed = Buffer.alloc(24, 0xAB);

  it('produces 81 bytes with tag 0x02', () => {
    const buf = encodeUserSpendingLeaf(addr, packed);
    expect(buf.length).toBe(81);
    expect(buf[0]).toBe(0x02);
  });

  it('throws for wrong packed24 length', () => {
    expect(() => encodeUserSpendingLeaf(addr, Buffer.alloc(10))).toThrow(
      /24-byte Buffer/
    );
  });
});

describe('encodeRefundBalanceLeaf', () => {
  const user = 'G' + 'D'.repeat(55);
  const token = 'C' + 'A'.repeat(55);

  it('produces 129 bytes with tag 0x03', () => {
    const buf = encodeRefundBalanceLeaf(user, token, 9_999n);
    expect(buf.length).toBe(129);
    expect(buf[0]).toBe(0x03);
  });
});

// ── Merkle tree ───────────────────────────────────────────────────────────────

describe('buildMerkleTree', () => {
  it('returns 32 zero bytes for an empty input', () => {
    const { root, leafHashes } = buildMerkleTree([]);
    expect(root.length).toBe(32);
    expect(root.every((b) => b === 0)).toBe(true);
    expect(leafHashes).toHaveLength(0);
  });

  it('root equals sha256(leaf) for a single leaf', () => {
    const crypto = require('crypto');
    const leaf = Buffer.from('hello');
    const { root } = buildMerkleTree([leaf]);
    const expected = crypto.createHash('sha256').update(leaf).digest();
    expect(root.equals(expected)).toBe(true);
  });

  it('is deterministic for two leaves', () => {
    const a = Buffer.from('leafA');
    const b = Buffer.from('leafB');
    const { root: r1 } = buildMerkleTree([a, b]);
    const { root: r2 } = buildMerkleTree([a, b]);
    expect(r1.equals(r2)).toBe(true);
  });

  it('produces the same root regardless of order (canonical sibling sort)', () => {
    const a = Buffer.from('alpha');
    const b = Buffer.from('beta');
    const { root: r1 } = buildMerkleTree([a, b]);
    const { root: r2 } = buildMerkleTree([b, a]);
    // Because pairs are sorted before hashing, both orderings give the same root.
    expect(r1.equals(r2)).toBe(true);
  });

  it('handles odd-length leaf arrays without error', () => {
    const leaves = [Buffer.from('x'), Buffer.from('y'), Buffer.from('z')];
    const { root } = buildMerkleTree(leaves);
    expect(root.length).toBe(32);
  });
});

// ── Merkle proof ──────────────────────────────────────────────────────────────

describe('buildMerkleProof + verifyMerkleProof', () => {
  const makeLeaves = (n) =>
    Array.from({ length: n }, (_, i) => Buffer.from(`leaf-${i}`));

  it('verifies every leaf in a 4-leaf tree', () => {
    const leaves = makeLeaves(4);
    const { root, leafHashes } = buildMerkleTree(leaves);
    const rootHex = root.toString('hex');

    for (let i = 0; i < leaves.length; i++) {
      const proof = buildMerkleProof(leaves, i);
      expect(verifyMerkleProof(leafHashes[i], proof, rootHex)).toBe(true);
    }
  });

  it('verifies every leaf in a 5-leaf tree (odd, triggers duplication)', () => {
    const leaves = makeLeaves(5);
    const { root, leafHashes } = buildMerkleTree(leaves);
    const rootHex = root.toString('hex');

    for (let i = 0; i < leaves.length; i++) {
      const proof = buildMerkleProof(leaves, i);
      expect(verifyMerkleProof(leafHashes[i], proof, rootHex)).toBe(true);
    }
  });

  it('rejects a tampered leaf hash', () => {
    const leaves = makeLeaves(4);
    const { root } = buildMerkleTree(leaves);
    const proof = buildMerkleProof(leaves, 0);
    const badHash = '00'.repeat(32);
    expect(verifyMerkleProof(badHash, proof, root.toString('hex'))).toBe(false);
  });

  it('rejects a tampered proof sibling', () => {
    const leaves = makeLeaves(4);
    const { root, leafHashes } = buildMerkleTree(leaves);
    const proof = buildMerkleProof(leaves, 0);
    proof[0] = '00'.repeat(32); // corrupt first sibling
    expect(verifyMerkleProof(leafHashes[0], proof, root.toString('hex'))).toBe(
      false
    );
  });
});

// ── commitArchiveEpoch ────────────────────────────────────────────────────────

describe('commitArchiveEpoch', () => {
  const addr = 'G' + 'E'.repeat(55);
  const entries = [
    {
      recordType: RECORD_TYPES.USER_VOLUME,
      primaryKey: addr,
      value: { volume: 1_000n },
    },
  ];
  const description = 'test-epoch';

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.archiveEpoch.findFirst.mockResolvedValue(null);
    prisma.archiveEpoch.create.mockResolvedValue({
      id: 'db-id-1',
      epoch: 1n,
      merkleRoot: 'aabbcc',
    });
  });

  it('calls contract commit_archive_root with root bytes and leaves', async () => {
    const contractClient = { commit_archive_root: jest.fn().mockResolvedValue(1n) };
    const result = await commitArchiveEpoch({ contractClient, entries, description });

    expect(contractClient.commit_archive_root).toHaveBeenCalledTimes(1);
    const call = contractClient.commit_archive_root.mock.calls[0][0];
    expect(call.root).toHaveLength(32);
    expect(call.leaves).toHaveLength(1);
    expect(call.description).toBe(description);
    expect(result.epochNumber).toBe(1n);
    expect(result.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  it('persists epoch and leaves to DB', async () => {
    const contractClient = { commit_archive_root: jest.fn().mockResolvedValue(2n) };
    await commitArchiveEpoch({ contractClient, entries, description });

    expect(prisma.archiveEpoch.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.archiveEpoch.create.mock.calls[0][0].data;
    expect(createArg.epoch).toBe(2n);
    expect(createArg.recordCount).toBe(1);
    expect(createArg.leaves.create).toHaveLength(1);
    expect(createArg.leaves.create[0].recordType).toBe(RECORD_TYPES.USER_VOLUME);
  });

  it('skips the contract call when root already committed (idempotency)', async () => {
    prisma.archiveEpoch.findFirst.mockResolvedValue({
      id: 'existing-id',
      epoch: 5n,
      merkleRoot: 'deadbeef',
    });
    const contractClient = { commit_archive_root: jest.fn() };
    const result = await commitArchiveEpoch({ contractClient, entries, description });

    expect(contractClient.commit_archive_root).not.toHaveBeenCalled();
    expect(result.epochNumber).toBe(5n);
    expect(result.dbEpochId).toBe('existing-id');
  });

  it('throws for an empty entries array', async () => {
    const contractClient = { commit_archive_root: jest.fn() };
    await expect(
      commitArchiveEpoch({ contractClient, entries: [], description })
    ).rejects.toThrow(/non-empty array/);
  });
});

// ── pruneArchivedEntries ──────────────────────────────────────────────────────

describe('pruneArchivedEntries', () => {
  const addr = 'G' + 'F'.repeat(55);

  beforeEach(() => jest.clearAllMocks());

  it('calls contract prune_archived_entries with the epoch leaves', async () => {
    prisma.archiveEpoch.findUnique.mockResolvedValue({
      id: 'db-id-1',
      epoch: 1n,
      leaves: [
        {
          recordType: RECORD_TYPES.USER_VOLUME,
          primaryKey: addr,
          secondaryKey: null,
        },
      ],
    });
    const contractClient = {
      prune_archived_entries: jest.fn().mockResolvedValue(1),
    };

    const { removed } = await pruneArchivedEntries({
      contractClient,
      epochNumber: 1n,
    });

    expect(contractClient.prune_archived_entries).toHaveBeenCalledTimes(1);
    const call = contractClient.prune_archived_entries.mock.calls[0][0];
    expect(call.committed_epoch).toBe(1n);
    expect(call.leaves).toHaveLength(1);
    expect(removed).toBe(1);
  });

  it('throws when the epoch is not in the DB', async () => {
    prisma.archiveEpoch.findUnique.mockResolvedValue(null);
    const contractClient = { prune_archived_entries: jest.fn() };

    await expect(
      pruneArchivedEntries({ contractClient, epochNumber: 99n })
    ).rejects.toThrow(/No DB record for archive epoch/);
    expect(contractClient.prune_archived_entries).not.toHaveBeenCalled();
  });
});

// ── verifyArchivedLeaf ────────────────────────────────────────────────────────

describe('verifyArchivedLeaf', () => {
  const addr = 'G' + 'H'.repeat(55);
  const leaf = encodeUserVolumeLeaf(addr, 250n);
  const crypto = require('crypto');
  const leafHash = crypto.createHash('sha256').update(leaf).digest('hex');

  const { root } = buildMerkleTree([leaf]);
  const rootHex = root.toString('hex');

  beforeEach(() => jest.clearAllMocks());

  it('returns valid=true when leaf is in DB root and root matches on-chain', async () => {
    prisma.archiveEpoch.findUnique.mockResolvedValue({
      id: 'db-id-1',
      epoch: 1n,
      merkleRoot: rootHex,
      leaves: [{ leafHash }],
    });
    const contractClient = {
      get_archive_info: jest.fn().mockResolvedValue([Array.from(root), {}]),
    };

    const result = await verifyArchivedLeaf({
      epochNumber: 1n,
      leafHash,
      contractClient,
    });

    expect(result.valid).toBe(true);
    expect(result.dbRoot).toBe(rootHex);
  });

  it('returns valid=false when epoch not in DB', async () => {
    prisma.archiveEpoch.findUnique.mockResolvedValue(null);
    const contractClient = { get_archive_info: jest.fn() };

    const result = await verifyArchivedLeaf({
      epochNumber: 99n,
      leafHash,
      contractClient,
    });

    expect(result.valid).toBe(false);
    expect(result.onChainRoot).toBeNull();
  });

  it('returns valid=false when leaf hash not found in DB', async () => {
    prisma.archiveEpoch.findUnique.mockResolvedValue({
      id: 'db-id-1',
      epoch: 1n,
      merkleRoot: rootHex,
      leaves: [{ leafHash: '00'.repeat(32) }], // different hash
    });
    const contractClient = { get_archive_info: jest.fn() };

    const result = await verifyArchivedLeaf({
      epochNumber: 1n,
      leafHash,
      contractClient,
    });

    expect(result.valid).toBe(false);
  });

  it('still validates against DB root when on-chain RPC fails', async () => {
    prisma.archiveEpoch.findUnique.mockResolvedValue({
      id: 'db-id-1',
      epoch: 1n,
      merkleRoot: rootHex,
      leaves: [{ leafHash }],
    });
    const contractClient = {
      get_archive_info: jest.fn().mockRejectedValue(new Error('RPC timeout')),
    };

    const result = await verifyArchivedLeaf({
      epochNumber: 1n,
      leafHash,
      contractClient,
    });

    // onChainRoot is null (RPC failed) but DB proof is still valid.
    expect(result.valid).toBe(true);
    expect(result.onChainRoot).toBeNull();
  });
});

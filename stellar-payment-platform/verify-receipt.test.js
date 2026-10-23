'use strict';

const {
  verifyProof,
  verifyBatchChain,
  computeBatchChainHash,
  hashLeaf,
  hashInternal,
  canonicalJson,
  buildMerkleTree,
} = require('./src/utils/verifyReceipt');

describe('verifyReceipt utilities', () => {
  describe('canonicalJson', () => {
    test('sorts object keys alphabetically', () => {
      const obj = { z: 1, a: 2, m: 3 };
      const result = canonicalJson(obj);
      expect(result).toBe('{"a":2,"m":3,"z":1}');
    });

    test('handles nested objects', () => {
      const obj = { b: { z: 1, a: 2 }, a: 1 };
      const result = canonicalJson(obj);
      expect(result).toBe('{"a":1,"b":{"a":2,"z":1}}');
    });

    test('handles arrays', () => {
      const obj = { items: [3, 1, 2] };
      const result = canonicalJson(obj);
      expect(result).toBe('{"items":[3,1,2]}');
    });

    test('handles primitives', () => {
      expect(canonicalJson('string')).toBe('"string"');
      expect(canonicalJson(123)).toBe('123');
      expect(canonicalJson(true)).toBe('true');
      expect(canonicalJson(null)).toBe('null');
    });
  });

  describe('hashLeaf', () => {
    test('produces consistent 32-byte hash for objects', () => {
      const data = { paymentId: 'test', amount: 100 };
      const hash1 = hashLeaf(data);
      const hash2 = hashLeaf(data);
      expect(hash1).toEqual(hash2);
      expect(hash1.length).toBe(32);
    });

    test('produces different hashes for different data', () => {
      const hash1 = hashLeaf({ a: 1 });
      const hash2 = hashLeaf({ a: 2 });
      expect(hash1.equals(hash2)).toBe(false);
    });

    test('handles string input', () => {
      const hash = hashLeaf('test string');
      expect(hash.length).toBe(32);
    });

    test('handles Buffer input', () => {
      const hash = hashLeaf(Buffer.from('test'));
      expect(hash.length).toBe(32);
    });
  });

  describe('hashInternal', () => {
    test('produces consistent 32-byte hash', () => {
      const left = Buffer.alloc(32, 0x01);
      const right = Buffer.alloc(32, 0x02);
      const hash1 = hashInternal(left, right);
      const hash2 = hashInternal(left, right);
      expect(hash1).toEqual(hash2);
      expect(hash1.length).toBe(32);
    });

    test('order matters', () => {
      const left = Buffer.alloc(32, 0x01);
      const right = Buffer.alloc(32, 0x02);
      const hash1 = hashInternal(left, right);
      const hash2 = hashInternal(right, left);
      expect(hash1.equals(hash2)).toBe(false);
    });
  });

  describe('verifyProof', () => {
    test('verifies valid proof for single leaf', () => {
      const leaves = [{ id: '1', value: 100 }];
      const { root, proofs } = buildMerkleTree(leaves);
      const valid = verifyProof(leaves[0], proofs[0], root);
      expect(valid).toBe(true);
    });

    test('verifies valid proof for multiple leaves', () => {
      const leaves = [
        { id: '1', value: 100 },
        { id: '2', value: 200 },
        { id: '3', value: 300 },
      ];
      const { root, proofs } = buildMerkleTree(leaves);
      for (let i = 0; i < leaves.length; i++) {
        const valid = verifyProof(leaves[i], proofs[i], root);
        expect(valid).toBe(true);
      }
    });

    test('rejects invalid proof', () => {
      const leaves = [{ id: '1', value: 100 }];
      const { root, proofs } = buildMerkleTree(leaves);
      const tamperedProof = [{ position: 'right', hash: '0'.repeat(64) }];
      const valid = verifyProof(leaves[0], tamperedProof, root);
      expect(valid).toBe(false);
    });

    test('rejects proof for different leaf', () => {
      const leaves = [
        { id: '1', value: 100 },
        { id: '2', value: 200 },
      ];
      const { root, proofs } = buildMerkleTree(leaves);
      const valid = verifyProof(leaves[1], proofs[0], root);
      expect(valid).toBe(false);
    });

    test('rejects invalid root', () => {
      const leaves = [{ id: '1', value: 100 }];
      const { root, proofs } = buildMerkleTree(leaves);
      const valid = verifyProof(leaves[0], proofs[0], '0'.repeat(64));
      expect(valid).toBe(false);
    });

    test('handles empty proof for single leaf tree', () => {
      const leaves = [{ id: '1', value: 100 }];
      const { root, proofs } = buildMerkleTree(leaves);
      expect(proofs[0]).toHaveLength(0);
      const valid = verifyProof(leaves[0], proofs[0], root);
      expect(valid).toBe(true);
    });

    test('returns false for malformed proof', () => {
      expect(verifyProof({}, null, 'root')).toBe(false);
      expect(verifyProof({}, [], null)).toBe(false);
      expect(verifyProof({}, [{}], 'root')).toBe(false);
      expect(verifyProof({}, [{ position: 'invalid', hash: '0'.repeat(64) }], 'root')).toBe(false);
    });
  });

  describe('computeBatchChainHash', () => {
    test('produces consistent chain hash', () => {
      const hash1 = computeBatchChainHash('prev', 'root', 123456789, 'batch1');
      const hash2 = computeBatchChainHash('prev', 'root', 123456789, 'batch1');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    test('handles GENESIS prev hash', () => {
      const hash = computeBatchChainHash(null, 'root', 123456789, 'batch1');
      expect(hash).toHaveLength(64);
    });

    test('different inputs produce different hashes', () => {
      const hash1 = computeBatchChainHash('prev', 'root', 123456789, 'batch1');
      const hash2 = computeBatchChainHash('prev', 'root', 123456790, 'batch1');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyBatchChain', () => {
    test('verifies valid chain', () => {
      const prev = 'prev_hash';
      const root = 'merkle_root';
      const timestamp = 123456789;
      const batchId = 'batch1';
      const chainHash = computeBatchChainHash(prev, root, timestamp, batchId);

      const valid = verifyBatchChain(prev, root, timestamp, batchId, chainHash);
      expect(valid).toBe(true);
    });

    test('rejects invalid chain hash', () => {
      const valid = verifyBatchChain('prev', 'root', 123456789, 'batch1', 'wrong_hash');
      expect(valid).toBe(false);
    });

    test('handles GENESIS prev hash', () => {
      const chainHash = computeBatchChainHash(null, 'root', 123456789, 'batch1');
      const valid = verifyBatchChain(null, 'root', 123456789, 'batch1', chainHash);
      expect(valid).toBe(true);
    });
  });

  describe('buildMerkleTree', () => {
    test('builds tree with single leaf', () => {
      const leaves = [{ id: '1' }];
      const { root, proofs, leafHashes } = buildMerkleTree(leaves);
      expect(root).toHaveLength(64);
      expect(proofs).toHaveLength(1);
      expect(proofs[0]).toHaveLength(0);
      expect(leafHashes).toHaveLength(1);
    });

    test('builds tree with two leaves', () => {
      const leaves = [{ id: '1' }, { id: '2' }];
      const { root, proofs, leafHashes } = buildMerkleTree(leaves);
      expect(root).toHaveLength(64);
      expect(proofs).toHaveLength(2);
      expect(proofs[0]).toHaveLength(1);
      expect(proofs[1]).toHaveLength(1);
      expect(leafHashes).toHaveLength(2);
    });

    test('builds tree with odd number of leaves (duplicates last)', () => {
      const leaves = [{ id: '1' }, { id: '2' }, { id: '3' }];
      const { root, proofs, leafHashes } = buildMerkleTree(leaves);
      expect(root).toHaveLength(64);
      expect(proofs).toHaveLength(3);
      expect(leafHashes).toHaveLength(3);
    });

    test('handles empty array', () => {
      const { root, proofs, leafHashes } = buildMerkleTree([]);
      expect(root).toBe('0'.repeat(64));
      expect(proofs).toHaveLength(0);
      expect(leafHashes).toHaveLength(0);
    });

    test('verifies all generated proofs', () => {
      const leaves = Array.from({ length: 10 }, (_, i) => ({ id: String(i), value: i * 10 }));
      const { root, proofs } = buildMerkleTree(leaves);
      for (let i = 0; i < leaves.length; i++) {
        const valid = verifyProof(leaves[i], proofs[i], root);
        expect(valid).toBe(true);
      }
    });
  });
});
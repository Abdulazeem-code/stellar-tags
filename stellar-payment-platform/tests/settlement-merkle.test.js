'use strict';

const crypto = require('crypto');
const {
  MerkleTree,
  hashLeaf,
  hashInternal,
  canonicalJson,
} = require('../src/settlement/merkleTree');

describe('Feature 27: MerkleTree Cryptographic Audit Engine', () => {
  describe('canonicalJson', () => {
    test('serializes objects deterministically regardless of key order', () => {
      const obj1 = { z: 1, a: 'test', m: { b: 2, a: 1 } };
      const obj2 = { a: 'test', m: { a: 1, b: 2 }, z: 1 };
      expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
    });

    test('serializes primitive values and arrays correctly', () => {
      expect(canonicalJson(null)).toBe('null');
      expect(canonicalJson(123)).toBe('123');
      expect(canonicalJson('hello')).toBe('"hello"');
      expect(canonicalJson([1, 'a', null])).toBe('[1,"a",null]');
    });
  });

  describe('hashLeaf and hashInternal', () => {
    test('produces 32-byte hash buffers with domain separation', () => {
      const leafHash = hashLeaf('sample-tx');
      expect(Buffer.isBuffer(leafHash)).toBe(true);
      expect(leafHash.length).toBe(32);

      const leafBuffer = hashLeaf(Buffer.from('sample-tx'));
      expect(leafBuffer).toEqual(leafHash);

      const internalHash = hashInternal(leafHash, leafHash);
      expect(Buffer.isBuffer(internalHash)).toBe(true);
      expect(internalHash.length).toBe(32);
      // Domain separation: internal node hash differs from raw double hash
      expect(internalHash).not.toEqual(leafHash);
    });
  });

  describe('MerkleTree construction and root calculation', () => {
    test('handles empty tree with default zero buffer', () => {
      const tree = new MerkleTree([]);
      expect(tree.getRoot().equals(Buffer.alloc(32, 0))).toBe(true);
      expect(tree.getRootHex()).toBe(Buffer.alloc(32, 0).toString('hex'));
    });

    test('throws if leaves is not an array', () => {
      expect(() => new MerkleTree(null)).toThrow(TypeError);
    });

    test('computes root for single leaf', () => {
      const data = { tx: 'tx_1', amount: '100' };
      const tree = new MerkleTree([data]);
      expect(tree.getRoot()).toEqual(hashLeaf(data));
    });

    test('computes consistent root for power of 2 leaves', () => {
      const leaves = ['tx_1', 'tx_2', 'tx_3', 'tx_4'];
      const tree = new MerkleTree(leaves);
      expect(tree.layers.length).toBe(3); // 4 leaves -> 2 nodes -> 1 root
      expect(tree.getRootHex().length).toBe(64);
    });

    test('handles odd number of leaves by balancing pairs', () => {
      const leaves = ['tx_1', 'tx_2', 'tx_3'];
      const tree = new MerkleTree(leaves);
      expect(tree.layers.length).toBe(3);
      expect(tree.getRootHex().length).toBe(64);
    });

    test('accepts pre-hashed leaf Buffers', () => {
      const h1 = hashLeaf('tx_1');
      const h2 = hashLeaf('tx_2');
      const tree = new MerkleTree([h1, h2], true);
      const expectedRoot = hashInternal(h1, h2);
      expect(tree.getRoot()).toEqual(expectedRoot);
    });
  });

  describe('Inclusion proofs generation and verification', () => {
    test('generates valid proof for every leaf in even and odd trees', () => {
      const counts = [1, 2, 3, 4, 7, 8, 15, 16];

      for (const count of counts) {
        const leaves = Array.from({ length: count }, (_, i) => ({
          txId: `tx_${i}`,
          amount: i * 10,
        }));
        const tree = new MerkleTree(leaves);
        const rootHex = tree.getRootHex();

        for (let i = 0; i < count; i++) {
          const proof = tree.getProof(i);
          const isValid = MerkleTree.verifyProof(leaves[i], proof, rootHex);
          expect(isValid).toBe(true);
        }
      }
    });

    test('throws RangeError when requesting proof for out-of-bounds index', () => {
      const tree = new MerkleTree(['tx_1', 'tx_2']);
      expect(() => tree.getProof(-1)).toThrow(RangeError);
      expect(() => tree.getProof(2)).toThrow(RangeError);
    });

    test('returns zero buffer when layers are empty', () => {
      const tree = new MerkleTree([]);
      tree.layers = [];
      expect(tree.getRoot().equals(Buffer.alloc(32, 0))).toBe(true);
    });

    test('fails verification when proof step position is neither left nor right', () => {
      const leaves = ['tx_1', 'tx_2'];
      const tree = new MerkleTree(leaves);
      const rootHex = tree.getRootHex();
      const invalidProof = [{ position: 'center', hash: crypto.randomBytes(32).toString('hex') }];
      expect(MerkleTree.verifyProof('tx_1', invalidProof, rootHex)).toBe(false);
    });

    test('fails verification when leaf payload is tampered', () => {
      const leaves = ['tx_orig_1', 'tx_orig_2', 'tx_orig_3', 'tx_orig_4'];
      const tree = new MerkleTree(leaves);
      const rootHex = tree.getRootHex();
      const proof = tree.getProof(1);

      const isValid = MerkleTree.verifyProof('tx_tampered_2', proof, rootHex);
      expect(isValid).toBe(false);
    });

    test('fails verification when proof hashes or positions are invalid', () => {
      const leaves = ['tx_1', 'tx_2'];
      const tree = new MerkleTree(leaves);
      const rootHex = tree.getRootHex();

      // Bad proof structure
      expect(MerkleTree.verifyProof('tx_1', null, rootHex)).toBe(false);
      expect(MerkleTree.verifyProof('tx_1', [{ position: 'invalid', hash: 'bad' }], rootHex)).toBe(false);
      expect(
        MerkleTree.verifyProof(
          'tx_1',
          [{ position: 'right', hash: 'not-32-bytes' }],
          rootHex
        )
      ).toBe(false);
      expect(MerkleTree.verifyProof('tx_1', [{ position: 'right', hash: 12345 }], rootHex)).toBe(false);
    });

    test('verifies pre-hashed leaf Buffers', () => {
      const leaf1 = hashLeaf('tx_1');
      const leaf2 = hashLeaf('tx_2');
      const tree = new MerkleTree([leaf1, leaf2], true);
      const proof = tree.getProof(0);

      expect(MerkleTree.verifyProof(leaf1, proof, tree.getRoot(), true)).toBe(true);
      expect(MerkleTree.verifyProof(leaf2, proof, tree.getRoot(), true)).toBe(false);
    });
  });

  describe('Batch state chaining and verification', () => {
    test('computes deterministic chain hash linking previous batch', () => {
      const prevBatchHash = '0000000000000000000000000000000000000000000000000000000000000000';
      const merkleRoot = 'a'.repeat(64);
      const timestamp = 1700000000000;
      const batchId = 'batch_1';

      const chainHash1 = MerkleTree.computeBatchChainHash(prevBatchHash, merkleRoot, timestamp, batchId);
      const chainHash2 = MerkleTree.computeBatchChainHash(prevBatchHash, merkleRoot, timestamp, batchId);

      expect(chainHash1).toBe(chainHash2);
      expect(chainHash1.length).toBe(64);
      expect(MerkleTree.verifyBatchChain(prevBatchHash, merkleRoot, timestamp, batchId, chainHash1)).toBe(true);
    });

    test('fails batch chain verification if previous hash or root is altered', () => {
      const prevBatchHash = 'abc';
      const root = '123';
      const chainHash = MerkleTree.computeBatchChainHash(prevBatchHash, root, 100, 'b1');

      expect(MerkleTree.verifyBatchChain('tampered_prev', root, 100, 'b1', chainHash)).toBe(false);
      expect(MerkleTree.verifyBatchChain(prevBatchHash, 'tampered_root', 100, 'b1', chainHash)).toBe(false);
      expect(MerkleTree.verifyBatchChain(prevBatchHash, root, 999, 'b1', chainHash)).toBe(false);
      expect(MerkleTree.verifyBatchChain(prevBatchHash, root, 100, 'b2', chainHash)).toBe(false);
    });
  });
});

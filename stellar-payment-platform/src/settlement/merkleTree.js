'use strict';

const crypto = require('crypto');

/**
 * Feature 27: Cryptographic Merkle Audit Tree
 *
 * Implements a binary Merkle tree with SHA-256 for tamper-evident batch auditing.
 * Features:
 * - Domain separation: 0x00 byte prefix for leaf hashes, 0x01 byte prefix for internal node hashes
 *   (prevents second-preimage attacks / leaf-internal collision).
 * - Deterministic leaf ordering and reproducible root calculation.
 * - Cryptographic inclusion proof generation and verification (O(log N)).
 * - Tamper-evident batch state chaining linking batches into an immutable ledger audit trail.
 */

const LEAF_PREFIX = Buffer.from([0x00]);
const INTERNAL_PREFIX = Buffer.from([0x01]);

/**
 * Computes SHA-256 hash of a buffer or string.
 * @param {Buffer|string} data
 * @returns {Buffer}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Serializes and hashes a leaf payload with domain separation prefix (0x00).
 * @param {unknown} data - Transaction, object, string, or Buffer
 * @returns {Buffer} 32-byte hash
 */
function hashLeaf(data) {
  let serialized;
  if (Buffer.isBuffer(data)) {
    serialized = data;
  } else if (typeof data === 'string') {
    serialized = Buffer.from(data, 'utf8');
  } else {
    // Deterministic JSON serialization
    serialized = Buffer.from(canonicalJson(data), 'utf8');
  }
  return sha256(Buffer.concat([LEAF_PREFIX, serialized]));
}

/**
 * Combines two child hashes into an internal node hash with domain separation prefix (0x01).
 * @param {Buffer} left - 32-byte left child hash
 * @param {Buffer} right - 32-byte right child hash
 * @returns {Buffer} 32-byte parent hash
 */
function hashInternal(left, right) {
  return sha256(Buffer.concat([INTERNAL_PREFIX, left, right]));
}

/**
 * Deterministically stringifies an object by sorting keys alphabetically.
 * @param {unknown} obj
 * @returns {string}
 */
function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * MerkleTree class representing a binary hash tree of batch transactions.
 */
class MerkleTree {
  /**
   * @param {Array<unknown>} leaves - Raw transaction items or pre-hashed leaf Buffers
   * @param {boolean} [areLeavesHashed=false] - True if leaves are already 32-byte Buffers
   */
  constructor(leaves = [], areLeavesHashed = false) {
    if (!Array.isArray(leaves)) {
      throw new TypeError('MerkleTree requires an array of leaves');
    }

    this.rawLeaves = leaves;
    this.leafHashes = leaves.map((leaf) =>
      areLeavesHashed && Buffer.isBuffer(leaf) && leaf.length === 32 ? leaf : hashLeaf(leaf)
    );

    this.layers = [];
    this.buildTree();
  }

  /**
   * Builds the tree layers from bottom to top.
   */
  buildTree() {
    if (this.leafHashes.length === 0) {
      this.layers = [[Buffer.alloc(32, 0)]];
      return;
    }

    this.layers = [this.leafHashes];
    let currentLayer = this.leafHashes;

    while (currentLayer.length > 1) {
      const nextLayer = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        // If odd number of nodes, duplicate the last node to balance the branch
        const right = i + 1 < currentLayer.length ? currentLayer[i + 1] : left;
        nextLayer.push(hashInternal(left, right));
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  /**
   * Returns the Merkle root hash as a hex string.
   * @returns {string} 64-character hex string
   */
  getRootHex() {
    return this.getRoot().toString('hex');
  }

  /**
   * Returns the Merkle root Buffer.
   * @returns {Buffer}
   */
  getRoot() {
    if (this.layers.length === 0) {
      return Buffer.alloc(32, 0);
    }
    const topLayer = this.layers[this.layers.length - 1];
    return topLayer[0] || Buffer.alloc(32, 0);
  }

  /**
   * Generates a cryptographic inclusion proof for a leaf at a given index.
   * @param {number} leafIndex
   * @returns {Array<{ position: 'left'|'right', hash: string }>}
   */
  getProof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= this.leafHashes.length) {
      throw new RangeError(`Leaf index ${leafIndex} out of bounds (0..${this.leafHashes.length - 1})`);
    }

    const proof = [];
    let currentIndex = leafIndex;

    for (let layerIndex = 0; layerIndex < this.layers.length - 1; layerIndex++) {
      const layer = this.layers[layerIndex];
      const isRightNode = currentIndex % 2 === 1;
      const pairIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      if (pairIndex < layer.length) {
        proof.push({
          position: isRightNode ? 'left' : 'right',
          hash: layer[pairIndex].toString('hex'),
        });
      } else {
        // Paired with self when odd length
        proof.push({
          position: 'right',
          hash: layer[currentIndex].toString('hex'),
        });
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Statically verifies an inclusion proof against a root.
   * @param {unknown} leafData - Raw leaf data or Buffer
   * @param {Array<{ position: 'left'|'right', hash: string }>} proof - Proof steps
   * @param {string|Buffer} root - Expected Merkle root
   * @param {boolean} [isLeafHashed=false]
   * @returns {boolean}
   */
  static verifyProof(leafData, proof, root, isLeafHashed = false) {
    if (!Array.isArray(proof) || !root) return false;

    let currentHash =
      isLeafHashed && Buffer.isBuffer(leafData) && leafData.length === 32
        ? leafData
        : hashLeaf(leafData);

    const rootBuffer = Buffer.isBuffer(root)
      ? root
      : Buffer.from(root, 'hex');

    for (const step of proof) {
      if (!step || typeof step.hash !== 'string') return false;
      const siblingHash = Buffer.from(step.hash, 'hex');
      if (siblingHash.length !== 32) return false;

      if (step.position === 'left') {
        currentHash = hashInternal(siblingHash, currentHash);
      } else if (step.position === 'right') {
        currentHash = hashInternal(currentHash, siblingHash);
      } else {
        return false;
      }
    }

    return currentHash.equals(rootBuffer);
  }

  /**
   * Computes a cryptographic chain hash linking this batch to previous batches.
   * Format: SHA256(prevBatchHash + ":" + merkleRoot + ":" + timestamp + ":" + batchId)
   *
   * @param {string} prevBatchHash - Previous batch chain hash (or Genesis marker)
   * @param {string} merkleRoot - Current batch Merkle root hex
   * @param {number|string} timestamp - Batch creation timestamp (ms)
   * @param {string} batchId - Unique batch identifier
   * @returns {string} 64-character hex hash
   */
  static computeBatchChainHash(prevBatchHash, merkleRoot, timestamp, batchId) {
    const preimage = `${prevBatchHash || 'GENESIS'}:${merkleRoot}:${timestamp}:${batchId}`;
    return sha256(Buffer.from(preimage, 'utf8')).toString('hex');
  }

  /**
   * Verifies the batch chain link integrity.
   * @param {string} prevBatchHash
   * @param {string} merkleRoot
   * @param {number|string} timestamp
   * @param {string} batchId
   * @param {string} expectedChainHash
   * @returns {boolean}
   */
  static verifyBatchChain(prevBatchHash, merkleRoot, timestamp, batchId, expectedChainHash) {
    const computed = MerkleTree.computeBatchChainHash(prevBatchHash, merkleRoot, timestamp, batchId);
    return computed.toLowerCase() === (expectedChainHash || '').toLowerCase();
  }
}

module.exports = {
  MerkleTree,
  hashLeaf,
  hashInternal,
  canonicalJson,
};

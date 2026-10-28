'use strict';

/**
 * Stellar Tags Receipt Verification Library
 *
 * Standalone, zero-dependency (except built-in crypto) verification of
 * Merkle inclusion proofs and batch chain integrity.
 *
 * This module can be used in browsers (via bundler) or Node.js without
 * any external API dependencies.
 *
 * @module verify-receipt
 */

const crypto = require('crypto');

const LEAF_PREFIX = Buffer.from([0x00]);
const INTERNAL_PREFIX = Buffer.from([0x01]);

/**
 * Computes SHA-256 hash of a buffer.
 * @param {Buffer|string} data
 * @returns {Buffer}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
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
 * Verifies a Merkle inclusion proof against a root.
 *
 * @param {unknown} leafData - Raw leaf data (object, string, or Buffer)
 * @param {Array<{ position: 'left'|'right', hash: string }>} proof - Proof steps from leaf to root
 * @param {string|Buffer} root - Expected Merkle root (hex string or Buffer)
 * @returns {boolean} True if proof is valid
 *
 * @example
 * const leafData = { paymentId: '...', transactionHash: '...', ... };
 * const proof = [{ position: 'right', hash: 'abc123...' }, ...];
 * const root = 'merkle_root_hex...';
 * const valid = verifyProof(leafData, proof, root);
 */
function verifyProof(leafData, proof, root) {
  if (!Array.isArray(proof) || !root) return false;

  let currentHash = hashLeaf(leafData);
  const rootBuffer = Buffer.isBuffer(root) ? root : Buffer.from(root, 'hex');

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
 * Computes a cryptographic chain hash linking a batch to previous batches.
 * Format: SHA256(prevBatchHash + ":" + merkleRoot + ":" + timestamp + ":" + batchId)
 *
 * @param {string} prevBatchHash - Previous batch chain hash (or 'GENESIS' for first batch)
 * @param {string} merkleRoot - Current batch Merkle root hex
 * @param {number|string} timestamp - Batch creation timestamp (ms)
 * @param {string} batchId - Unique batch identifier
 * @returns {string} 64-character hex hash
 */
function computeBatchChainHash(prevBatchHash, merkleRoot, timestamp, batchId) {
  const preimage = `${prevBatchHash || 'GENESIS'}:${merkleRoot}:${timestamp}:${batchId}`;
  return sha256(Buffer.from(preimage, 'utf8')).toString('hex');
}

/**
 * Verifies the batch chain link integrity.
 *
 * @param {string} prevBatchHash
 * @param {string} merkleRoot
 * @param {number|string} timestamp
 * @param {string} batchId
 * @param {string} expectedChainHash
 * @returns {boolean}
 */
function verifyBatchChain(prevBatchHash, merkleRoot, timestamp, batchId, expectedChainHash) {
  const computed = computeBatchChainHash(prevBatchHash, merkleRoot, timestamp, batchId);
  return computed.toLowerCase() === (expectedChainHash || '').toLowerCase();
}

/**
 * Builds a Merkle tree from leaf data and returns root + proofs for all leaves.
 *
 * @param {Array<unknown>} leaves - Array of leaf data objects
 * @returns {{ root: string, proofs: Array<Array<{position: string, hash: string}>>, leafHashes: string[] }}
 */
function buildMerkleTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    return { root: Buffer.alloc(32, 0).toString('hex'), proofs: [], leafHashes: [] };
  }

  const leafHashes = leaves.map(leaf => hashLeaf(leaf).toString('hex'));
  const layers = [leafHashes.map(h => Buffer.from(h, 'hex'))];

  let currentLayer = layers[0];
  while (currentLayer.length > 1) {
    const nextLayer = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i];
      const right = i + 1 < currentLayer.length ? currentLayer[i + 1] : left;
      nextLayer.push(hashInternal(left, right));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  const root = currentLayer[0].toString('hex');

  const proofs = leafHashes.map((_, leafIndex) => {
    const proof = [];
    let currentIndex = leafIndex;
    for (let layerIndex = 0; layerIndex < layers.length - 1; layerIndex++) {
      const layer = layers[layerIndex];
      const isRightNode = currentIndex % 2 === 1;
      const pairIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      if (pairIndex < layer.length) {
        proof.push({
          position: isRightNode ? 'left' : 'right',
          hash: layer[pairIndex].toString('hex'),
        });
      } else {
        proof.push({
          position: 'right',
          hash: layer[currentIndex].toString('hex'),
        });
      }
      currentIndex = Math.floor(currentIndex / 2);
    }
    return proof;
  });

  return { root, proofs, leafHashes };
}

/**
 * Verifies a payment receipt using data from the API.
 * This is a convenience function that fetches and verifies in one call.
 *
 * @param {string} apiBase - Base URL of the Stellar Tags API (e.g., 'http://localhost:5000')
 * @param {string} paymentId - UUID of the payment to verify
 * @returns {Promise<{ valid: boolean, verified: boolean, anchorTxHash: string|null, anchorStatus: string, merkleRoot: string, error?: string }>}
 */
async function verifyPaymentReceipt(apiBase, paymentId) {
  try {
    const fetch = (await import('node-fetch')).default;
    const url = `${apiBase.replace(/\/$/, '')}/api/v1/payments/${paymentId}/receipt-proof`;
    const response = await fetch(url);
    if (!response.ok) {
      return { valid: false, verified: false, anchorTxHash: null, anchorStatus: 'error', merkleRoot: '', error: `HTTP ${response.status}` };
    }
    const result = await response.json();
    if (!result.success) {
      return { valid: false, verified: false, anchorTxHash: null, anchorStatus: 'error', merkleRoot: '', error: result.error?.message };
    }

    const data = result.data;
    const leafData = {
      paymentId: data.paymentId,
      transactionHash: data.transactionHash,
      from: data.from,
      to: data.to,
      amount: data.amount,
      assetCode: data.assetCode || 'XLM',
      timestamp: data.timestamp,
      index: data.leafIndex,
    };

    const valid = verifyProof(leafData, data.proof, data.merkleRoot);

    return {
      valid,
      verified: data.verified,
      anchorTxHash: data.anchorTxHash,
      anchorStatus: data.anchorStatus,
      merkleRoot: data.merkleRoot,
    };
  } catch (err) {
    return { valid: false, verified: false, anchorTxHash: null, anchorStatus: 'error', merkleRoot: '', error: err.message };
  }
}

/**
 * Verifies a batch anchor chain.
 *
 * @param {string} apiBase - Base URL of the Stellar Tags API
 * @param {string} batchId - Batch ID to verify
 * @returns {Promise<{ valid: boolean, chainValid: boolean, merkleRoot: string, anchorTxHash: string|null, error?: string }>}
 */
async function verifyBatchAnchor(apiBase, batchId) {
  try {
    const fetch = (await import('node-fetch')).default;
    const url = `${apiBase.replace(/\/$/, '')}/api/v1/receipts/anchors?limit=1000`;
    const response = await fetch(url);
    if (!response.ok) {
      return { valid: false, chainValid: false, merkleRoot: '', anchorTxHash: null, error: `HTTP ${response.status}` };
    }
    const result = await response.json();
    const anchor = result.data?.find(a => a.batchId === batchId);
    if (!anchor) {
      return { valid: false, chainValid: false, merkleRoot: '', anchorTxHash: null, error: 'Batch not found' };
    }

    const chainValid = verifyBatchChain(
      anchor.prevBatchHash,
      anchor.merkleRoot,
      anchor.batchTimestamp,
      anchor.batchId,
      anchor.chainHash
    );

    return {
      valid: true,
      chainValid,
      merkleRoot: anchor.merkleRoot,
      anchorTxHash: anchor.anchorTxHash,
    };
  } catch (err) {
    return { valid: false, chainValid: false, merkleRoot: '', anchorTxHash: null, error: err.message };
  }
}

module.exports = {
  verifyProof,
  verifyBatchChain,
  computeBatchChainHash,
  hashLeaf,
  hashInternal,
  canonicalJson,
  buildMerkleTree,
  verifyPaymentReceipt,
  verifyBatchAnchor,
};
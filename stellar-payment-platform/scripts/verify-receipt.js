#!/usr/bin/env node
'use strict';

/**
 * Stellar Tags Receipt Verification CLI
 *
 * Verifies cryptographic Merkle inclusion proofs for payments without API dependencies.
 * Can verify proofs fetched from the API or constructed manually.
 *
 * Usage:
 *   node scripts/verify-receipt.js --payment-id <uuid> --api-base <url>
 *   node scripts/verify-receipt.js --leaf-data '{"paymentId":"...",...}' --proof '[...]' --root <hex>
 *   node scripts/verify-receipt.js --batch-id <id> --payment-index <n> --api-base <url>
 */

const crypto = require('crypto');
const { program } = require('commander');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const LEAF_PREFIX = Buffer.from([0x00]);
const INTERNAL_PREFIX = Buffer.from([0x01]);

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

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

function hashInternal(left, right) {
  return sha256(Buffer.concat([INTERNAL_PREFIX, left, right]));
}

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

function verifyBatchChain(prevBatchHash, merkleRoot, timestamp, batchId, expectedChainHash) {
  const preimage = `${prevBatchHash || 'GENESIS'}:${merkleRoot}:${timestamp}:${batchId}`;
  const computed = sha256(Buffer.from(preimage, 'utf8')).toString('hex');
  return computed.toLowerCase() === (expectedChainHash || '').toLowerCase();
}

async function fetchReceiptFromApi(apiBase, paymentId) {
  const url = `${apiBase.replace(/\/$/, '')}/api/v1/payments/${paymentId}/receipt-proof`;
  const response = await fetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(`API error: ${response.status} ${response.statusText} - ${JSON.stringify(error)}`);
  }
  return response.json();
}

async function fetchAnchorFromApi(apiBase, batchId) {
  const url = `${apiBase.replace(/\/$/, '')}/api/v1/receipts/anchors?limit=1000`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.data?.find(a => a.batchId === batchId) || null;
}

async function main() {
  program
    .name('verify-receipt')
    .description('Verify Stellar Tags payment receipt Merkle proofs')
    .version('1.0.0');

  program
    .option('-p, --payment-id <uuid>', 'Payment ID to verify (fetches proof from API)')
    .option('-b, --batch-id <id>', 'Batch ID to verify against')
    .option('-i, --payment-index <n>', 'Payment index within batch (for batch verification)')
    .option('-a, --api-base <url>', 'API base URL (e.g., http://localhost:5000)')
    .option('--leaf-data <json>', 'Raw leaf data as JSON string')
    .option('--proof <json>', 'Merkle proof as JSON array')
    .option('--root <hex>', 'Merkle root as hex string')
    .option('--prev-root <hex>', 'Previous batch root for chain verification')
    .option('--timestamp <ms>', 'Batch timestamp in milliseconds')
    .option('--batch-id <id>', 'Batch ID for chain verification')
    .option('--chain-hash <hex>', 'Expected chain hash for batch verification')
    .option('-v, --verbose', 'Verbose output')
    .option('--json', 'Output result as JSON');

  program.parse(process.argv);
  const options = program.opts();

  if (options.verbose) {
    console.log('Options:', JSON.stringify(options, null, 2));
  }

  try {
    let leafData, proof, root, anchorTxHash, anchorStatus, verified = false;
    let prevBatchHash, batchTimestamp, chainHash;

    if (options.paymentId && options.apiBase) {
      console.log(`Fetching receipt proof for payment ${options.paymentId}...`);
      const result = await fetchReceiptFromApi(options.apiBase, options.paymentId);
      if (!result.success) {
        throw new Error(`API returned error: ${result.error?.message || 'Unknown'}`);
      }
      const data = result.data;
      leafData = {
        paymentId: data.paymentId,
        transactionHash: data.transactionHash,
        from: data.from,
        to: data.to,
        amount: data.amount,
        assetCode: data.assetCode || 'XLM',
        timestamp: data.timestamp,
        index: data.leafIndex,
      };
      proof = data.proof;
      root = data.merkleRoot;
      anchorTxHash = data.anchorTxHash;
      anchorStatus = data.anchorStatus;
      verified = data.verified;

      if (options.verbose) {
        console.log('Fetched receipt:', JSON.stringify(data, null, 2));
      }
    } else if (options.batchId && options.paymentIndex !== undefined && options.apiBase) {
      console.log(`Fetching anchor for batch ${options.batchId}...`);
      const anchor = await fetchAnchorFromApi(options.apiBase, options.batchId);
      if (!anchor) {
        throw new Error(`Batch ${options.batchId} not found`);
      }
      console.log(`Fetching payment at index ${options.paymentIndex}...`);
      // Note: This would require an API endpoint to fetch individual payments by batch/index
      // For now, we'll just verify the chain
      root = anchor.merkleRoot;
      prevBatchHash = anchor.prevBatchHash;
      batchTimestamp = anchor.batchTimestamp;
      chainHash = anchor.chainHash;

      const chainValid = verifyBatchChain(prevBatchHash, root, batchTimestamp, options.batchId, chainHash);
      console.log(`Batch chain verification: ${chainValid ? 'VALID' : 'INVALID'}`);
      if (options.json) {
        console.log(JSON.stringify({ batchChainValid: chainValid }, null, 2));
      }
      process.exit(chainValid ? 0 : 1);
    } else if (options.leafData && options.proof && options.root) {
      leafData = JSON.parse(options.leafData);
      proof = JSON.parse(options.proof);
      root = options.root;
    } else {
      console.error('Error: Must provide either --payment-id with --api-base, or --leaf-data with --proof and --root');
      program.help();
      process.exit(1);
    }

    if (leafData && proof && root) {
      console.log('Verifying Merkle inclusion proof...');
      if (options.verbose) {
        console.log('Leaf data:', JSON.stringify(leafData, null, 2));
        console.log('Proof steps:', proof.length);
        console.log('Root:', root);
      }

      const isValid = verifyProof(leafData, proof, root);

      console.log(`Merkle proof verification: ${isValid ? 'VALID' : 'INVALID'}`);

      if (options.json) {
        console.log(JSON.stringify({
          valid: isValid,
          merkleRoot: root,
          anchorTxHash,
          anchorStatus,
          verified,
        }, null, 2));
      }

      if (!isValid) {
        process.exit(1);
      }
    }

    if (options.prevRoot && options.timestamp && options.batchId && options.chainHash) {
      console.log('Verifying batch chain...');
      const chainValid = verifyBatchChain(
        options.prevRoot,
        root,
        options.timestamp,
        options.batchId,
        options.chainHash
      );
      console.log(`Batch chain verification: ${chainValid ? 'VALID' : 'INVALID'}`);
      if (options.json) {
        console.log(JSON.stringify({ batchChainValid: chainValid }, null, 2));
      }
      if (!chainValid) {
        process.exit(1);
      }
    }

    console.log('✓ All verifications passed');
    process.exit(0);
  } catch (err) {
    console.error('✗ Verification failed:', err.message);
    if (options.verbose) {
      console.error(err.stack);
    }
    if (options.json) {
      console.log(JSON.stringify({ valid: false, error: err.message }, null, 2));
    }
    process.exit(1);
  }
}

main();
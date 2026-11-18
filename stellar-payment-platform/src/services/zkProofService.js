'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const { buildBn128, utils } = require('ffjavascript');

const { unstringifyBigInts } = utils;

/**
 * Zero-knowledge range proofs for confidential settlement amounts.
 *
 * The Groth16 circuit in `zk/rangeProof.circom` proves, without revealing the
 * amount, that:
 *
 *   amount > 0
 *   amount < maxLimit
 *   commitment = Poseidon(amount, blinding)
 *
 * `maxLimit` and `commitment` are the only public signals. Proofs are encoded
 * as a compact binary blob (see `serializeProof`) so they can be stored or
 * submitted without JSON overhead.
 */

const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_UINT64 = (1n << 64n) - 1n;
const DEFAULT_MAX_LIMIT = 1000000000000n;
const FIELD_BYTES = 32;
const PROOF_MAGIC = Buffer.from('5a4b5031', 'hex'); // "ZKP1"
const PROOF_VERSION = 1;

let verifierPromise = null;

function artifactPaths() {
  const directory =
    process.env.ZK_ARTIFACT_DIR ||
    path.join(__dirname, '..', '..', 'zk', 'artifacts');

  return {
    wasm: process.env.ZK_WASM_PATH || path.join(directory, 'rangeProof.wasm'),
    zkey: process.env.ZK_ZKEY_PATH || path.join(directory, 'rangeProof_final.zkey'),
    verificationKey:
      process.env.ZK_VERIFICATION_KEY_PATH ||
      path.join(directory, 'verification_key.json'),
  };
}

function configuredMaxLimit() {
  const raw = process.env.ZK_MAX_PAYMENT_AMOUNT;
  if (raw === undefined || raw === '') return DEFAULT_MAX_LIMIT;

  let value;
  try {
    value = BigInt(raw);
  } catch {
    throw new Error('ZK_MAX_PAYMENT_AMOUNT must be a base-10 integer');
  }

  if (value <= 0n || value > MAX_UINT64) {
    throw new Error('ZK_MAX_PAYMENT_AMOUNT must be between 1 and 2^64 - 1');
  }
  return value;
}

function toInteger(value, name) {
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${name} must be a safe integer`);
    }
    return BigInt(value);
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }

  throw new TypeError(`${name} must be an integer`);
}

function toFieldElement(value, name) {
  const parsed = typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value.trim())
    ? BigInt(value.trim())
    : toInteger(value, name);

  if (parsed < 0n || parsed >= FIELD_ORDER) {
    throw new RangeError(`${name} must be a valid BN128 scalar`);
  }
  return parsed;
}

function randomBlinding() {
  for (;;) {
    const candidate = BigInt(`0x${crypto.randomBytes(31).toString('hex')}`);
    if (candidate !== 0n) return candidate;
  }
}

function fieldToBuffer(value) {
  const parsed = toFieldElement(value, 'field element');
  return Buffer.from(parsed.toString(16).padStart(FIELD_BYTES * 2, '0'), 'hex');
}

function bufferToField(buffer, offset) {
  return BigInt(`0x${buffer.subarray(offset, offset + FIELD_BYTES).toString('hex')}`);
}

function fieldToHex(value) {
  const hex = toFieldElement(value, 'field element')
    .toString(16)
    .padStart(FIELD_BYTES * 2, '0');
  return `0x${hex}`;
}

function assertProofShape(proof, publicSignals) {
  const validA = Array.isArray(proof?.pi_a) && proof.pi_a.length >= 2;
  const validB =
    Array.isArray(proof?.pi_b) &&
    proof.pi_b.length >= 2 &&
    Array.isArray(proof.pi_b[0]) &&
    Array.isArray(proof.pi_b[1]) &&
    proof.pi_b[0].length >= 2 &&
    proof.pi_b[1].length >= 2;
  const validC = Array.isArray(proof?.pi_c) && proof.pi_c.length >= 2;

  if (!validA || !validB || !validC) {
    throw new TypeError('proof must contain pi_a, pi_b and pi_c points');
  }
  if (!Array.isArray(publicSignals) || publicSignals.length === 0) {
    throw new TypeError('publicSignals must be a non-empty array');
  }
  if (publicSignals.length > 255) {
    throw new RangeError('publicSignals cannot contain more than 255 values');
  }
}

/**
 * Encode a Groth16 proof and its public signals as a single compact hex string.
 *
 * Layout (big-endian field elements):
 *   magic(4) | version(1) | pi_a(64) | pi_b(128) | pi_c(64) | nPublic(1) | signals(32 * n)
 *
 * @param {object} proof - snarkjs Groth16 proof object.
 * @param {Array<string|bigint|number>} publicSignals - Public inputs/outputs.
 * @returns {string} hex encoded proof and public signals (no 0x prefix).
 */
function serializeProof(proof, publicSignals) {
  assertProofShape(proof, publicSignals);

  const values = [
    proof.pi_a[0],
    proof.pi_a[1],
    proof.pi_b[0][0],
    proof.pi_b[0][1],
    proof.pi_b[1][0],
    proof.pi_b[1][1],
    proof.pi_c[0],
    proof.pi_c[1],
  ];

  const buffer = Buffer.alloc(
    PROOF_MAGIC.length + 1 + values.length * FIELD_BYTES + 1 + publicSignals.length * FIELD_BYTES,
  );

  let offset = 0;
  PROOF_MAGIC.copy(buffer, offset);
  offset += PROOF_MAGIC.length;
  buffer.writeUInt8(PROOF_VERSION, offset);
  offset += 1;

  for (const value of values) {
    fieldToBuffer(value).copy(buffer, offset);
    offset += FIELD_BYTES;
  }

  buffer.writeUInt8(publicSignals.length, offset);
  offset += 1;

  for (const signal of publicSignals) {
    fieldToBuffer(signal).copy(buffer, offset);
    offset += FIELD_BYTES;
  }

  return buffer.toString('hex');
}

/**
 * Decode a proof produced by {@link serializeProof}.
 *
 * @param {string} encoded - Hex string, with or without a 0x prefix.
 * @returns {{proof: object, publicSignals: string[], commitment: string, maxLimit: string}}
 */
function deserializeProof(encoded) {
  if (typeof encoded !== 'string') {
    throw new TypeError('encoded proof must be a hex string');
  }

  const hex = encoded.trim().replace(/^0x/i, '');
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new TypeError('encoded proof must be a valid hex string');
  }

  const buffer = Buffer.from(hex, 'hex');
  const headerLength = PROOF_MAGIC.length + 1 + 8 * FIELD_BYTES + 1;
  if (buffer.length < headerLength) {
    throw new TypeError('encoded proof is truncated');
  }
  if (!buffer.subarray(0, PROOF_MAGIC.length).equals(PROOF_MAGIC)) {
    throw new TypeError('encoded proof has an unknown format');
  }

  let offset = PROOF_MAGIC.length;
  const version = buffer.readUInt8(offset);
  offset += 1;
  if (version !== PROOF_VERSION) {
    throw new TypeError(`unsupported proof version: ${version}`);
  }

  const values = [];
  for (let i = 0; i < 8; i += 1) {
    values.push(bufferToField(buffer, offset));
    offset += FIELD_BYTES;
  }

  const publicSignalCount = buffer.readUInt8(offset);
  offset += 1;
  if (buffer.length !== offset + publicSignalCount * FIELD_BYTES) {
    throw new TypeError('encoded proof has an invalid length');
  }

  const publicSignals = [];
  for (let i = 0; i < publicSignalCount; i += 1) {
    publicSignals.push(bufferToField(buffer, offset).toString());
    offset += FIELD_BYTES;
  }

  const proof = {
    pi_a: [values[0].toString(), values[1].toString(), '1'],
    pi_b: [
      [values[2].toString(), values[3].toString()],
      [values[4].toString(), values[5].toString()],
      ['1', '0'],
    ],
    pi_c: [values[6].toString(), values[7].toString(), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };

  return {
    proof,
    publicSignals,
    commitment: fieldToHex(publicSignals[0]),
    maxLimit: publicSignals[1],
  };
}

async function prepareVerifier() {
  const { verificationKey } = artifactPaths();
  const raw = JSON.parse(fs.readFileSync(verificationKey, 'utf8'));
  const vkey = unstringifyBigInts(raw);

  // A single-threaded curve instance avoids worker startup costs and keeps
  // verification well below the 50 ms budget in the acceptance criteria.
  const curve = await buildBn128(true);

  return {
    curve,
    order: curve.r,
    ic0: curve.G1.fromObject(vkey.IC[0]),
    ic: vkey.IC.slice(1).map((point) => curve.G1.fromObject(point)),
    gamma2: curve.G2.fromObject(vkey.vk_gamma_2),
    delta2: curve.G2.fromObject(vkey.vk_delta_2),
    alpha1: curve.G1.fromObject(vkey.vk_alpha_1),
    beta2: curve.G2.fromObject(vkey.vk_beta_2),
    publicSignalCount: vkey.nPublic,
  };
}

function getVerifier() {
  if (!verifierPromise) {
    verifierPromise = prepareVerifier().catch((error) => {
      verifierPromise = null;
      throw error;
    });
  }
  return verifierPromise;
}

async function verifyWithPrepared(prepared, proof, publicSignals) {
  if (publicSignals.length !== prepared.publicSignalCount) return false;

  const signals = publicSignals.map((signal) => BigInt(signal));
  for (const signal of signals) {
    if (signal < 0n || signal >= prepared.order) return false;
  }

  const { curve } = prepared;
  let cpub = prepared.ic0;
  for (let i = 0; i < signals.length; i += 1) {
    cpub = curve.G1.add(cpub, curve.G1.timesScalar(prepared.ic[i], signals[i]));
  }

  const normalizedProof = unstringifyBigInts(proof);
  const piA = curve.G1.fromObject(normalizedProof.pi_a);
  const piB = curve.G2.fromObject(normalizedProof.pi_b);
  const piC = curve.G1.fromObject(normalizedProof.pi_c);

  if (
    !curve.G1.isValid(piA) ||
    !curve.G2.isValid(piB) ||
    !curve.G1.isValid(piC)
  ) {
    return false;
  }

  return curve.pairingEq(
    curve.G1.neg(piA),
    piB,
    cpub,
    prepared.gamma2,
    piC,
    prepared.delta2,
    prepared.alpha1,
    prepared.beta2,
  );
}

/**
 * Preload the verification key and curve so the first verification call does
 * not pay the initialisation cost.
 */
async function initialize() {
  await getVerifier();
}

/**
 * Verify an encoded range proof.
 *
 * @param {string} encoded - Serialized proof and public signals.
 * @param {object} [options]
 * @param {string|bigint|number} [options.maxLimit] - Expected upper bound.
 * @param {string|bigint|number} [options.commitment] - Expected commitment.
 * @returns {Promise<boolean>} true only for an authentic proof.
 */
async function verifyProof(encoded, options = {}) {
  let decoded;
  try {
    decoded = deserializeProof(encoded);
  } catch {
    return false;
  }

  const expectedMaxLimit =
    options.maxLimit === undefined
      ? configuredMaxLimit()
      : toInteger(options.maxLimit, 'maxLimit');

  if (BigInt(decoded.maxLimit) !== expectedMaxLimit) return false;

  if (options.commitment !== undefined) {
    const expectedCommitment = toFieldElement(options.commitment, 'commitment');
    if (BigInt(decoded.publicSignals[0]) !== expectedCommitment) return false;
  }

  const prepared = await getVerifier();
  try {
    return await verifyWithPrepared(prepared, decoded.proof, decoded.publicSignals);
  } catch {
    return false;
  }
}

/**
 * Generate a Groth16 range proof for a payment amount.
 *
 * @param {string|bigint|number} amount - Integer amount to prove.
 * @param {object} [options]
 * @param {string|bigint|number} [options.blinding] - Optional commitment blinding factor.
 * @param {string|bigint|number} [options.maxLimit] - Exclusive upper bound.
 * @returns {Promise<{proofHex: string, publicSignals: string[], commitment: string, maxLimit: string}>}
 */
async function generateRangeProof(amount, options = {}) {
  const amountValue = toInteger(amount, 'amount');
  if (amountValue <= 0n) {
    throw new RangeError('amount must be greater than zero');
  }
  if (amountValue > MAX_UINT64) {
    throw new RangeError('amount must fit in 64 bits');
  }

  const maxLimit =
    options.maxLimit === undefined
      ? configuredMaxLimit()
      : toInteger(options.maxLimit, 'maxLimit');
  if (maxLimit <= 0n || maxLimit > MAX_UINT64) {
    throw new RangeError('maxLimit must be between 1 and 2^64 - 1');
  }
  if (amountValue >= maxLimit) {
    throw new RangeError('amount must be less than maxLimit');
  }

  const blinding =
    options.blinding === undefined
      ? randomBlinding()
      : toFieldElement(options.blinding, 'blinding');
  if (blinding === 0n) {
    throw new RangeError('blinding must be greater than zero');
  }

  const { wasm, zkey } = artifactPaths();
  if (!fs.existsSync(wasm) || !fs.existsSync(zkey)) {
    throw new Error(`ZK proving artifacts not found in ${path.dirname(wasm)}`);
  }

  const input = {
    amount: amountValue.toString(),
    blinding: blinding.toString(),
    maxLimit: maxLimit.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasm,
    zkey,
    undefined,
    { singleThread: true },
    { singleThread: true },
  );

  const proofHex = serializeProof(proof, publicSignals);
  const valid = await verifyProof(proofHex, {
    maxLimit,
    commitment: publicSignals[0],
  });
  if (!valid) {
    throw new Error('generated proof failed local verification');
  }

  return {
    proofHex,
    publicSignals,
    commitment: fieldToHex(publicSignals[0]),
    maxLimit: maxLimit.toString(),
  };
}

module.exports = {
  DEFAULT_MAX_LIMIT,
  FIELD_ORDER,
  MAX_UINT64,
  configuredMaxLimit,
  deserializeProof,
  generateRangeProof,
  initialize,
  serializeProof,
  verifyProof,
};

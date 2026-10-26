'use strict';

const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');

const {
  MAX_UINT64,
  deserializeProof,
  generateRangeProof,
  initialize,
  serializeProof,
  verifyProof,
} = require('../src/services/zkProofService');

const AMOUNT = 25_000_000n;
const MAX_LIMIT = 1_000_000_000n;
const BLINDING = 123_456_789_012_345_678n;
const VERIFICATION_KEY = path.join(
  __dirname,
  '..',
  'zk',
  'artifacts',
  'verification_key.json',
);

describe('zkProofService', () => {
  let proof;

  beforeAll(async () => {
    await initialize();
    proof = await generateRangeProof(AMOUNT, {
      blinding: BLINDING,
      maxLimit: MAX_LIMIT,
    });
  }, 60_000);

  test('generates a proof bound to the commitment and limit', () => {
    expect(proof.proofHex).toMatch(/^[0-9a-f]+$/);
    expect(proof.publicSignals).toHaveLength(2);
    expect(BigInt(proof.publicSignals[1])).toBe(MAX_LIMIT);
    expect(proof.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(proof.commitment)).toBe(BigInt(proof.publicSignals[0]));
    expect(BigInt(proof.maxLimit)).toBe(MAX_LIMIT);
  });

  test('accepts an authentic proof', async () => {
    await expect(
      verifyProof(proof.proofHex, {
        maxLimit: MAX_LIMIT,
        commitment: proof.commitment,
      }),
    ).resolves.toBe(true);
  });

  test('decoded proof is accepted by the reference snarkjs verifier', async () => {
    const decoded = deserializeProof(proof.proofHex);
    const verificationKey = JSON.parse(fs.readFileSync(VERIFICATION_KEY, 'utf8'));

    await expect(
      snarkjs.groth16.verify(
        verificationKey,
        decoded.publicSignals,
        decoded.proof,
      ),
    ).resolves.toBe(true);
  });

  test('round-trips serialization', () => {
    const decoded = deserializeProof(proof.proofHex);
    expect(serializeProof(decoded.proof, decoded.publicSignals)).toBe(
      proof.proofHex,
    );
  });

  test('rejects a tampered proof', async () => {
    const tampered =
      proof.proofHex.slice(0, 20) +
      (proof.proofHex[20] === '0' ? '1' : '0') +
      proof.proofHex.slice(21);

    await expect(verifyProof(tampered, { maxLimit: MAX_LIMIT })).resolves.toBe(
      false,
    );
  });

  test('rejects a tampered commitment', async () => {
    const decoded = deserializeProof(proof.proofHex);
    decoded.publicSignals[0] = (
      BigInt(decoded.publicSignals[0]) + 1n
    ).toString();
    const tampered = serializeProof(decoded.proof, decoded.publicSignals);

    await expect(verifyProof(tampered, { maxLimit: MAX_LIMIT })).resolves.toBe(
      false,
    );
  });

  test('rejects a proof produced for a different limit', async () => {
    await expect(
      verifyProof(proof.proofHex, { maxLimit: MAX_LIMIT + 1n }),
    ).resolves.toBe(false);
  });

  test('rejects malformed encodings without throwing', async () => {
    for (const invalid of ['', '0x', 'zz', '00', proof.proofHex.slice(0, -2)]) {
      await expect(verifyProof(invalid, { maxLimit: MAX_LIMIT })).resolves.toBe(
        false,
      );
    }
  });

  test('rejects amounts outside the permitted range', async () => {
    await expect(
      generateRangeProof(0, { maxLimit: MAX_LIMIT }),
    ).rejects.toThrow(/greater than zero/);
    await expect(
      generateRangeProof(MAX_LIMIT, { maxLimit: MAX_LIMIT }),
    ).rejects.toThrow(/less than maxLimit/);
    await expect(
      generateRangeProof(MAX_UINT64 + 1n, { maxLimit: MAX_UINT64 }),
    ).rejects.toThrow(/64 bits/);
  });

  test('verifies a proof in under 50ms after warm-up', async () => {
    const timings = [];

    for (let i = 0; i < 6; i += 1) {
      const started = process.hrtime.bigint();
      const valid = await verifyProof(proof.proofHex, { maxLimit: MAX_LIMIT });
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

      expect(valid).toBe(true);
      timings.push(elapsed);
    }

    // The first call still includes V8 warm-up; the acceptance criterion is
    // about steady-state verification cost.
    const measured = timings.slice(1).sort((a, b) => a - b);
    const median = measured[Math.floor(measured.length / 2)];
    expect(median).toBeLessThan(50);
  });
});

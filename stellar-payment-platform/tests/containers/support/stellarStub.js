'use strict';

/**
 * #686 — the one thing this phase stubs, and why.
 *
 * `@stellar/stellar-sdk` cannot be required from Jest's CommonJS runtime: its
 * `lib/cjs/federation/server.js` is ESM, so `require('@stellar/stellar-sdk')`
 * throws "Cannot use import statement outside a module" the moment `server.js`
 * loads it, and the package's `exports` map blocks the deep CJS paths that would
 * otherwise work. Horizon is also unreachable from CI, so every network call has
 * to be stubbed regardless.
 *
 * What is *not* stubbed is the shape of the answer. `StrKey
 * .isValidEd25519PublicKey` re-implements StrKey's real rules — base32 alphabet,
 * 56 characters, the `6 << 3` version byte that makes the key start with `G`, and
 * the little-endian CRC16-XModem checksum over the first 33 decoded bytes — so a
 * test that expects a malformed address to be rejected is exercising the
 * handler's validation order rather than a function that always returns true.
 * `publicKeyFor` mints fixtures that satisfy the same checksum, so `makeAddress`
 * in ./harness produces keys the real SDK would also accept.
 *
 * Signature *verification* stays a stub: proving it needs the matching private
 * key, which is the opposite of what a test fixture should contain.
 */

const crypto = require('node:crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ED25519_PUBLIC_KEY_VERSION_BYTE = 6 << 3; // 0x30, renders as a leading "G"
const ED25519_PUBLIC_KEY_BYTES = 35; // version + 32 payload + 2 CRC
const ED25519_PUBLIC_KEY_CHARS = 56;

/** CRC16-XModem, the checksum StrKey appends to an ed25519 public key. */
function crc16xmodem(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= (bytes[i] & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Decode base32 to bytes, or null if a character is outside the alphabet. */
function decodeBase32(value) {
  const bytes = [];
  let accumulator = 0;
  let bits = 0;

  for (let i = 0; i < value.length; i += 1) {
    const index = BASE32_ALPHABET.indexOf(value[i]);
    if (index === -1) return null;
    accumulator = ((accumulator << 5) | index) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }

  // A well-formed key encodes whole bytes only: no dangling bits.
  return bits === 0 ? bytes : null;
}

function encodeBase32(bytes) {
  let result = '';
  let accumulator = 0;
  let bits = 0;

  for (let i = 0; i < bytes.length; i += 1) {
    accumulator = ((accumulator << 8) | (bytes[i] & 0xff)) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(accumulator >> bits) & 31];
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  }

  return result;
}

/**
 * StrKey.isValidEd25519PublicKey, reimplemented.
 *
 * The checksum is read little-endian, i.e. `crc & 0xff` first, which is the
 * detail a hand-rolled check most often gets wrong.
 */
function isValidEd25519PublicKey(value) {
  if (typeof value !== 'string' || value.length !== ED25519_PUBLIC_KEY_CHARS) return false;

  const bytes = decodeBase32(value);
  if (!bytes || bytes.length !== ED25519_PUBLIC_KEY_BYTES) return false;
  if (bytes[0] !== ED25519_PUBLIC_KEY_VERSION_BYTE) return false;

  const expected = bytes[33] | (bytes[34] << 8);
  return crc16xmodem(bytes.slice(0, 33)) === expected;
}

/** A deterministic, checksum-valid Stellar public key for a given seed. */
function publicKeyFor(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest();

  const bytes = [ED25519_PUBLIC_KEY_VERSION_BYTE, ...digest];
  // 35 bytes total, so pad the payload out to 32 bytes deterministically.
  for (let i = 0; i < 32 - digest.length; i += 1) {
    bytes.push(digest[i % digest.length]);
  }

  const checksum = crc16xmodem(bytes.slice(0, 33));
  bytes.push(checksum & 0xff, (checksum >> 8) & 0xff);

  return encodeBase32(bytes);
}

const sdkMock = {
  Horizon: { Server: jest.fn() },
  StrKey: {
    isValidEd25519PublicKey: jest.fn((value) => isValidEd25519PublicKey(value)),
    isValidSecretKey: jest.fn(
      (value) =>
        typeof value === 'string' &&
        value.length === ED25519_PUBLIC_KEY_CHARS &&
        decodeBase32(value) !== null &&
        decodeBase32(value)[0] === (18 << 3), // 0x90, renders as a leading "S"
    ),
  },
  Keypair: {
    fromPublicKey: jest.fn(() => ({
      // Signature checking is out of reach without the private key; the routes
      // that call it are asserted on the surrounding behaviour instead.
      verify: jest.fn(() => true),
    })),
  },
};

module.exports = {
  sdkMock,
  crc16xmodem,
  decodeBase32,
  encodeBase32,
  isValidEd25519PublicKey,
  publicKeyFor,
};

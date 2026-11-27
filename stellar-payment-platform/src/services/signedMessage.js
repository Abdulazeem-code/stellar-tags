'use strict';

/**
 * Verifying "signed message" proofs from Stellar wallets.
 *
 * The API asks a wallet to sign a short text (for example
 * `payment-request:alice*example.com`) to prove the caller controls an
 * account. Wallets do not agree on the details, so one place handles them:
 *
 * - Encoding: base64 (Freighter, most kits), 128-char hex, or the ASCII bytes
 *   of a base64 string base64-encoded again (seen with some wallet kits).
 * - What was signed: SEP-53 (sha256 of "Stellar Signed Message:\n" + text),
 *   the raw text (older signBlob-style wallets), or the prefixed text unhashed.
 *
 * Registration always accepted all of these. The other ownership checks only
 * accepted base64 + SEP-53, so a signature that registered a tag was then
 * refused when the same wallet created a payment request or a webhook.
 */

const crypto = require('crypto');

const SEP53_PREFIX = Buffer.from('Stellar Signed Message:\n', 'utf8');
const HEX_SIGNATURE = /^[0-9a-fA-F]{128}$/;
const BASE64_TEXT = /^[a-zA-Z0-9+/]+={0,2}$/;

/**
 * Turns a wallet signature into raw bytes.
 * @param {Buffer|string} signature
 * @returns {Buffer}
 * @throws {Error} 'Invalid message signature format.' (statusCode 400) for other types
 */
const decodeSignature = (signature) => {
  if (Buffer.isBuffer(signature)) return signature;
  if (typeof signature !== 'string') {
    const error = new Error('Invalid message signature format.');
    error.statusCode = 400;
    throw error;
  }
  if (HEX_SIGNATURE.test(signature)) return Buffer.from(signature, 'hex');

  const decoded = Buffer.from(signature, 'base64');
  // 64 signature bytes base64-encoded are 88 characters; decoding a doubly
  // encoded signature therefore yields 80-90 bytes of base64 text.
  if (decoded.length >= 80 && decoded.length <= 90) {
    const text = decoded.toString('utf8');
    if (BASE64_TEXT.test(text)) return Buffer.from(text, 'base64');
  }
  return decoded;
};

/** The byte strings a wallet may have signed for `message`, SEP-53 first. */
const signedPayloads = (message) => {
  const messageBytes = Buffer.from(message, 'utf8');
  const prefixed = Buffer.concat([SEP53_PREFIX, messageBytes]);
  return [
    crypto.createHash('sha256').update(prefixed).digest(),
    messageBytes,
    prefixed,
  ];
};

/**
 * True when `signature` is a valid signature of `message` by `keypair` in any
 * of the forms wallets produce.
 * @param {{ verify: (data: Buffer, signature: Buffer) => boolean }} keypair
 * @param {string} message
 * @param {Buffer|string} signature
 */
const verifySignedMessage = (keypair, message, signature) => {
  const signatureBuffer = decodeSignature(signature);
  return signedPayloads(message).some((payload) => {
    try {
      return keypair.verify(payload, signatureBuffer);
    } catch {
      return false;
    }
  });
};

module.exports = {
  SEP53_PREFIX,
  decodeSignature,
  signedPayloads,
  verifySignedMessage,
};

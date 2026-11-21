'use strict';

const crypto = require('crypto');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');

/**
 * Verifies a Freighter-signed message against a registered account's public
 * key, following the SEP-0053 prefix used by Freighter before signing.
 *
 * Freighter prefixes the payload with `Stellar Signed Message:\n` and hashes it
 * with SHA-256 before signing. The signature may arrive as a Buffer or a
 * base64 string.
 *
 * @param {object} params
 * @param {string} params.message    The cleartext message that was signed.
 * @param {Buffer|string} params.signature The signature produced by the wallet.
 * @param {string} [params.signerAddress] Optional explicit signer (defaults to publicKey).
 * @param {string} params.publicKey  The registered Stellar account public key (G...).
 * @returns {string} The signer public key that was verified.
 * @throws {Error} 400 when the signer address is not a valid Ed25519 public key,
 *                 400 for an invalid signature format, 401 when verification
 *                 fails or the signer does not match the registered account.
 */
function verifyFreighterSignedMessage({ message, signature, signerAddress, publicKey }) {
  const claimedSigner = signerAddress || publicKey;

  if (!StrKey.isValidEd25519PublicKey(claimedSigner)) {
    const error = new Error('Invalid signer address format.');
    error.statusCode = 400;
    error.code = 'INVALID_INPUT';
    throw error;
  }

  const keypair = Keypair.fromPublicKey(claimedSigner);

  let signatureBuffer;
  if (Buffer.isBuffer(signature)) {
    signatureBuffer = signature;
  } else if (typeof signature === 'string') {
    signatureBuffer = Buffer.from(signature, 'base64');
  } else {
    const error = new Error('Invalid message signature format.');
    error.statusCode = 400;
    error.code = 'INVALID_INPUT';
    throw error;
  }

  const prefix = Buffer.from('Stellar Signed Message:\n', 'utf8');
  const messageBytes = Buffer.from(message, 'utf8');
  const payload = Buffer.concat([prefix, messageBytes]);
  const messageHash = crypto.createHash('sha256').update(payload).digest();

  if (!keypair.verify(messageHash, signatureBuffer)) {
    const error = new Error('Signature verification failed.');
    error.statusCode = 401;
    error.code = 'UNAUTHENTICATED';
    throw error;
  }

  if (claimedSigner !== publicKey) {
    const error = new Error('Signer address does not match the registered account.');
    error.statusCode = 401;
    error.code = 'UNAUTHENTICATED';
    throw error;
  }

  return claimedSigner;
}

module.exports = { verifyFreighterSignedMessage };

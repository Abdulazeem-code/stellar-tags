'use strict';

const crypto = require('crypto');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');

const verifyFreighterRegistrationSignature = ({
  username,
  address,
  signature,
  signerAddress,
}) => {
  const message = `register:${username}:${address}`;
  const claimedSigner = signerAddress || address;

  if (!StrKey.isValidEd25519PublicKey(claimedSigner)) {
    const error = new Error('Invalid signer address format.');
    error.statusCode = 400;
    throw error;
  }

  const keypair = Keypair.fromPublicKey(claimedSigner);

  let signatureBuffer;
  if (Buffer.isBuffer(signature)) {
    signatureBuffer = signature;
  } else if (typeof signature === 'string') {
    // If it's a 128-char hex string
    if (signature.length === 128 && /^[0-9a-fA-F]+$/.test(signature)) {
      signatureBuffer = Buffer.from(signature, 'hex');
    } else {
      signatureBuffer = Buffer.from(signature, 'base64');
      // If the resulting buffer is 86-88 bytes long, it might be the ASCII bytes of a base64 string (double encoded)
      if (signatureBuffer.length >= 80 && signatureBuffer.length <= 90) {
        const text = signatureBuffer.toString('utf8');
        if (/^[a-zA-Z0-9+/]+={0,2}$/.test(text)) {
          signatureBuffer = Buffer.from(text, 'base64');
        }
      }
    }
  } else {
    throw new Error('Invalid message signature format.');
  }

  // --- SEP-0053 Verification Logic ---
  // Freighter adds a specific prefix and hashes the payload before signing
  const prefix = Buffer.from('Stellar Signed Message:\n', 'utf8');
  const messageBytes = Buffer.from(message, 'utf8');
  const payload = Buffer.concat([prefix, messageBytes]);
  const messageHash = crypto.createHash('sha256').update(payload).digest();

  // Verify against the hashed payload (SEP-0053) first
  if (!keypair.verify(messageHash, signatureBuffer)) {
    // If that fails, try verifying the raw message directly in case the wallet used signBlob
    if (!keypair.verify(messageBytes, signatureBuffer)) {
      // Also try verifying the payload without hashing it
      if (!keypair.verify(payload, signatureBuffer)) {
        const error = new Error('Signature verification failed.');
        error.statusCode = 401;
        throw error;
      }
    }
  }

  if (claimedSigner !== address) {
    const error = new Error('Signer address does not match the connected wallet.');
    error.statusCode = 401;
    throw error;
  }

  return claimedSigner;
};

module.exports = {
  verifyFreighterRegistrationSignature,
};

'use strict';

/**
 * Proves that a caller controls the Stellar account behind a username.
 *
 * The caller signs `${operation}:${username}` with the account key. Either a
 * Freighter-style signed message or a multi-signer threshold is accepted, the
 * same two paths the webhook endpoints have always used. Extracted here so the
 * webhook routes and the activity endpoint share one implementation.
 */

const crypto = require('crypto');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');
const { prisma } = require('../../prismaClient');
const { poolGet } = require('../db');
const { verifyMultiSignerThreshold } = require('../multisigner-verifier');
const { normalizeNameTag, shouldFallbackToLocalRegistry } = require('../utils');

const httpError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const verifyFreighterSignedMessage = ({ message, signature, signerAddress, publicKey }) => {
  const claimedSigner = signerAddress || publicKey;

  if (!StrKey.isValidEd25519PublicKey(claimedSigner)) {
    throw httpError('Invalid signer address format.', 400);
  }

  const keypair = Keypair.fromPublicKey(claimedSigner);

  let signatureBuffer;
  if (Buffer.isBuffer(signature)) {
    signatureBuffer = signature;
  } else if (typeof signature === 'string') {
    signatureBuffer = Buffer.from(signature, 'base64');
  } else {
    throw new Error('Invalid message signature format.');
  }

  const prefix = Buffer.from('Stellar Signed Message:\n', 'utf8');
  const messageBytes = Buffer.from(message, 'utf8');
  const payload = Buffer.concat([prefix, messageBytes]);
  const messageHash = crypto.createHash('sha256').update(payload).digest();

  if (!keypair.verify(messageHash, signatureBuffer)) {
    throw httpError('Signature verification failed.', 401);
  }

  if (claimedSigner !== publicKey) {
    throw httpError('Signer address does not match the registered account.', 401);
  }

  return claimedSigner;
};

const findUserRecord = async (username) => {
  try {
    return await prisma.user.findUnique({
      where: { username },
      select: { username: true, address: true },
    });
  } catch (err) {
    if (!shouldFallbackToLocalRegistry(err)) throw err;
    const localRow = await poolGet(
      'SELECT username, address FROM username_registry WHERE username = $1 LIMIT 1',
      [username],
    );
    return localRow ? { username: localRow.username, address: localRow.address } : null;
  }
};

/**
 * @returns {Promise<{username: string, address: string}>} the authenticated user
 * @throws {Error} with `statusCode` set on any failure
 */
const authenticateUsernameOwner = async ({
  username: rawUsername,
  signature: rawSignature,
  signerAddress: rawSignerAddress,
  operation = 'webhook',
}) => {
  const username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
  const signature = typeof rawSignature === 'string' ? rawSignature.trim() : '';
  const signerAddress =
    typeof rawSignerAddress === 'string' ? rawSignerAddress.trim() : undefined;

  if (!username) throw httpError('Missing required field: username.', 400);
  if (!signature) throw httpError('Missing required field: signature.', 400);

  const normalizedUsername = normalizeNameTag(username).toLowerCase();
  const userRecord = await findUserRecord(normalizedUsername);

  if (!userRecord) throw httpError('Username not registered.', 404);

  const message = `${operation}:${normalizedUsername}`;

  if (StrKey.isValidEd25519PublicKey(signature) && !signerAddress) {
    const verificationResult = await verifyMultiSignerThreshold(
      userRecord.address,
      [signature],
      { operationType: 'management' },
    );
    if (!verificationResult.success) {
      throw httpError(verificationResult.errorMessage || 'Signature verification failed', 401);
    }
  } else {
    verifyFreighterSignedMessage({
      message,
      signature,
      signerAddress,
      publicKey: userRecord.address,
    });
  }

  return userRecord;
};

module.exports = {
  authenticateUsernameOwner,
  verifyFreighterSignedMessage,
};

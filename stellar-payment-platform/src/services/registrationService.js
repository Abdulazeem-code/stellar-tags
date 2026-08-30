const { StrKey } = require('@stellar/stellar-sdk');
const { prisma } = require('../../../prismaClient');
const { verifyMultiSignerThreshold } = require('../../multisigner-verifier');
const { logger } = require('../../logger');

async function transferAccount(username, oldAddress, newAddress, oldSignature, newSignature) {
  if (!username) {
    const error = new Error('Username is required');
    error.statusCode = 400;
    throw error;
  }

  if (!oldAddress || !newAddress) {
    const error = new Error('Both oldAddress and newAddress are required');
    error.statusCode = 400;
    throw error;
  }

  if (!StrKey.isValidEd25519PublicKey(newAddress)) {
    const error = new Error('Invalid Stellar Public Key format for new address');
    error.statusCode = 400;
    throw error;
  }

  if (!oldSignature || !newSignature) {
    const error = new Error('Signatures from both old and new addresses are required');
    error.statusCode = 400;
    throw error;
  }

  // 1. Verify old address exists and matches username
  const user = await prisma.user.findUnique({
    where: { username }
  });

  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  if (user.address !== oldAddress) {
    const error = new Error('Old address does not match current record');
    error.statusCode = 400;
    throw error;
  }

  // 2. Verify old signature against the current address
  const oldVerification = await verifyMultiSignerThreshold(oldAddress, [oldSignature], {
    operationType: 'management',
  });
  if (!oldVerification.success) {
    const error = new Error(oldVerification.errorMessage || 'Signature verification failed for the current address');
    error.statusCode = 401;
    throw error;
  }

  // 3. Verify new signature against the new address
  const newVerification = await verifyMultiSignerThreshold(newAddress, [newSignature], {
    operationType: 'management',
  });
  if (!newVerification.success) {
    const error = new Error(newVerification.errorMessage || 'Signature verification failed for the new address');
    error.statusCode = 401;
    throw error;
  }

  // 4. Atomically update the address in Prisma
  const updatedUser = await prisma.user.update({
    where: { username },
    data: { address: newAddress },
  });

  logger.info(`Transferred username ${username} from ${oldAddress} to ${newAddress}`);

  // The ETag-based federation cache will automatically be invalidated for both addresses
  // because the underlying DB data has changed. No manual cache purging is needed.

  return updatedUser;
}

module.exports = {
  transferAccount,
};

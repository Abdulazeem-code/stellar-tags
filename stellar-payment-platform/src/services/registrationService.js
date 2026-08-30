'use strict';

const xss = require('xss');
const { StrKey } = require('@stellar/stellar-sdk');
const Filter = require('bad-words');
const { prisma } = require('../../prismaClient');
const { poolRun } = require('../db');
const {
  normalizeNameTag,
  validateMemo,
  MAX_USERNAMES_PER_ADDRESS,
  shouldFallbackToLocalRegistry,
} = require('../utils');
const { verifyMultiSignerThreshold } = require('../multisigner-verifier');
const { verifyFreighterRegistrationSignature } = require('./signatureService');
const { getLocalUserByAddress, getLocalUserByUsername } = require('./userService');
const { invalidateFederationCache } = require('../cache');

const profanityFilter = new Filter();

const RESERVED_USERNAMES = [
  'admin',
  'root',
  'stellar',
  'system',
  'superuser',
  'administrator',
  'support',
];
const RESERVED_NAMES = ['admin', 'root', 'support', 'system', 'stellar', 'api', 'help'];

const registerLocalUser = async ({ username, address, isPrimary = false }) => {
  const existingByUsername = await getLocalUserByUsername(username);
  if (existingByUsername) {
    const conflictError = new Error('Username is already taken. Please choose another.');
    conflictError.statusCode = 409;
    throw conflictError;
  }

  await poolRun(
    `INSERT INTO username_registry (username, address, is_primary, created_at)
     VALUES (?, ?, ?, ?)`,
    [username, address, isPrimary, new Date().toISOString()],
  );
};

const registerUser = async (payload) => {
  const safeUsername = xss(payload.username);
  const username = normalizeNameTag(safeUsername);
  const { address, memo_type: memoType, memo, signature = '', signerAddress = '' } = payload;

  if (address.toUpperCase().startsWith('S')) {
    const error = new Error('Never share your Secret Key. Please register using your Public Key (starts with G).');
    error.statusCode = 400; // INVALID_INPUT usually mapped to 400
    error.code = 'INVALID_INPUT';
    throw error;
  }

  const usernameLocalPart = username.includes('*') ? username.split('*')[0] : username;

  if (profanityFilter.isProfane(usernameLocalPart)) {
    const error = new Error('Username contains restricted words');
    error.statusCode = 400;
    error.code = 'INVALID_INPUT';
    throw error;
  }

  if (!StrKey.isValidEd25519PublicKey(address)) {
    const error = new Error('Invalid Stellar Public Key format.');
    error.statusCode = 400;
    throw error;
  }

  const memoError = validateMemo(memoType, memo);
  if (memoError) {
    const error = new Error(memoError);
    error.statusCode = 400;
    error.code = 'INVALID_INPUT';
    throw error;
  }

  const normalizedUsername = username.toLowerCase();
  
  const normalizedLocalPart = normalizedUsername.includes('*') ? normalizedUsername.split('*')[0] : normalizedUsername;
  if (RESERVED_USERNAMES.includes(normalizedLocalPart)) {
    const error = new Error('Username is reserved.');
    error.statusCode = 403;
    throw error;
  }

  if (RESERVED_NAMES.includes(normalizedUsername)) {
    const error = new Error('This username is reserved and cannot be registered.');
    error.statusCode = 403;
    error.code = 'FORBIDDEN';
    throw error;
  }

  let usernameCount = 0;
  try {
    usernameCount = await prisma.user.count({
      where: { address, deletedAt: null },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) {
      throw error;
    }
    usernameCount = (await getLocalUserByAddress(address)) ? 1 : 0;
  }

  if (usernameCount >= MAX_USERNAMES_PER_ADDRESS) {
    const error = new Error(`This address already has the maximum of ${MAX_USERNAMES_PER_ADDRESS} federation usernames.`);
    error.statusCode = 409;
    error.code = 'CONFLICT';
    throw error;
  }
  const isPrimary = usernameCount === 0;

  let verificationResult = null;
  if (signature) {
    const isLegacyPublicKeyFlow =
      StrKey.isValidEd25519PublicKey(signature) && !signerAddress;

    if (isLegacyPublicKeyFlow) {
      verificationResult = await verifyMultiSignerThreshold(address, [signature], {
        operationType: 'management',
      });

      if (!verificationResult.success) {
        const verificationError = new Error(
          verificationResult.errorMessage || 'Signature verification failed'
        );
        verificationError.statusCode = 401;
        throw verificationError;
      }
    } else {
      const claimedSigner = verifyFreighterRegistrationSignature({
        username: payload.username,
        address: payload.address,
        signature,
        signerAddress,
      });

      verificationResult = {
        success: true,
        accountId: claimedSigner,
        operationType: 'message',
        requiredThreshold: 1,
        totalWeight: 1,
        signatureCount: 1,
        uniqueSignerCount: 1,
        signatures: [
          {
            publicKey: claimedSigner,
            weight: 1,
            isValid: true,
          },
        ],
        thresholds: {
          low_threshold: 1,
          med_threshold: 1,
          high_threshold: 1,
        },
        signerCount: 1,
        errorMessage: null,
      };
    }
  }

  try {
    await prisma.user.create({
      data: {
        username: normalizedUsername,
        address,
        isPrimary,
        ...(memoType && { memoType, memo }),
      },
    });
    invalidateFederationCache(normalizedUsername, address);
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) {
      throw error;
    }
    await registerLocalUser({ username: normalizedUsername, address, isPrimary });
  }

  return {
    ok: true,
    username: normalizedUsername,
    address,
    is_primary: isPrimary,
    federation_address: `${normalizedUsername}*${process.env.DOMAIN || 'localhost'}`,
    ...(verificationResult && {
      verification: {
        accountId: verificationResult.accountId,
        signerCount: verificationResult.signerCount,
        thresholdMet: verificationResult.success,
        requiredThreshold: verificationResult.requiredThreshold,
        providedWeight: verificationResult.totalWeight,
      },
    }),
    ...(memoType && { memo_type: memoType, memo }),
  };
};

module.exports = {
  registerLocalUser,
  registerUser,
};

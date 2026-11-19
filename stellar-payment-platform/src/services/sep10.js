'use strict';

/**
 * SEP-10 challenge issuance for GET /auth.
 *
 * The SDK is required lazily so a disabled SEP-10 configuration never depends
 * on it. Only public data is logged; signing secrets, challenge XDR and
 * signatures never enter log messages or the stored Redis value.
 */

const crypto = require('crypto');
const { ApiError } = require('../errors');
const { getSep10Config } = require('../config/sep10');
const { sep10ChallengeQuerySchema } = require('../schemas/sep10ChallengeSchema');

const CHALLENGE_KEY_PREFIX = 'sep10:challenge:';

const invalid = (message, cause) =>
  new ApiError('INVALID_INPUT', message, cause === undefined ? {} : { cause });

const challengeHash = (transaction) =>
  crypto.createHash('sha256').update(transaction).digest('hex');

function validateQuery(query) {
  const parsed = sep10ChallengeQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    const issue = parsed.error && parsed.error.issues && parsed.error.issues[0];
    throw invalid(issue && issue.message ? issue.message : 'Invalid challenge request');
  }
  return parsed.data;
}

function loadSdk() {
  let sdk;
  try {
    sdk = require('@stellar/stellar-sdk');
  } catch (_err) {
    throw new ApiError('INTERNAL_ERROR', 'Stellar SDK is unavailable');
  }

  if (
    !sdk ||
    !sdk.WebAuth ||
    typeof sdk.WebAuth.buildChallengeTx !== 'function' ||
    !sdk.Keypair ||
    typeof sdk.Keypair.fromSecret !== 'function' ||
    !sdk.StrKey
  ) {
    throw new ApiError('INTERNAL_ERROR', 'Stellar SDK does not support SEP-10 challenges');
  }

  return sdk;
}

function validateAccount(sdk, account) {
  const muxed = account.startsWith('M');
  const validator = muxed
    ? sdk.StrKey.isValidMed25519PublicKey
    : sdk.StrKey.isValidEd25519PublicKey;

  let isValid = false;
  if (typeof validator === 'function') {
    try {
      isValid = Boolean(validator.call(sdk.StrKey, account));
    } catch (_err) {
      isValid = false;
    }
  }

  if (!isValid) {
    throw invalid('account must be a valid Stellar G... or M... address');
  }
  return muxed;
}

/**
 * Builds a SEP-10 challenge and records its hash in Redis for one-time use.
 *
 * @param {Record<string, unknown>} query raw Express query object
 * @param {import('redis').RedisClientType|null} redisClient
 * @param {NodeJS.ProcessEnv} [env] injectable for tests
 * @returns {Promise<{ transaction: string, network_passphrase: string }>}
 */
async function createSep10Challenge(query, redisClient, env = process.env) {
  const config = getSep10Config(env);
  if (!config.enabled) {
    throw new ApiError('NOT_FOUND', 'SEP-10 is not enabled');
  }
  if (!redisClient || typeof redisClient.set !== 'function') {
    throw new ApiError('SERVICE_UNAVAILABLE', 'Redis is not configured');
  }

  const { account, memo, home_domain: requestedHomeDomain } = validateQuery(query);
  if (requestedHomeDomain && requestedHomeDomain !== config.homeDomain) {
    throw invalid('home_domain does not match the configured home domain');
  }

  const sdk = loadSdk();
  const muxed = validateAccount(sdk, account);
  if (muxed && memo) {
    throw invalid('memo cannot be used with a muxed account');
  }

  let keypair;
  try {
    keypair = sdk.Keypair.fromSecret(String(env.SEP10_SIGNING_SECRET).trim());
  } catch (_err) {
    // The config module already validated this value; keep the failure generic.
    throw new ApiError('INTERNAL_ERROR', 'SEP-10 signing key is unavailable');
  }

  let transaction;
  try {
    transaction = sdk.WebAuth.buildChallengeTx(
      keypair,
      account,
      config.homeDomain,
      config.challengeTimeoutSeconds,
      config.networkPassphrase,
      config.webAuthDomain,
      memo || null,
      null,
      null,
    );
  } catch (err) {
    // The SDK rejects invalid memo/muxed combinations. All inputs are checked
    // above, so return a safe message that cannot leak XDR or signing material.
    throw invalid('Invalid challenge parameters', err);
  }

  if (typeof transaction !== 'string' || transaction.length === 0) {
    throw new ApiError('INTERNAL_ERROR', 'Unable to build challenge transaction');
  }

  const hash = challengeHash(transaction);
  try {
    await redisClient.set(`${CHALLENGE_KEY_PREFIX}${hash}`, hash, {
      EX: config.challengeTimeoutSeconds,
    });
  } catch (err) {
    throw new ApiError('SERVICE_UNAVAILABLE', 'Redis is unavailable', { cause: err });
  }

  return { transaction, network_passphrase: config.networkPassphrase };
}

module.exports = {
  createSep10Challenge,
  challengeHash,
  CHALLENGE_KEY_PREFIX,
};

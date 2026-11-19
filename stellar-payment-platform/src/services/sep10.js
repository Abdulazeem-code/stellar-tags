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
const { sep10TokenBodySchema } = require('../schemas/sep10TokenSchema');

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

function loadSdk({ verify = false } = {}) {
  let sdk;
  try {
    sdk = require('@stellar/stellar-sdk');
  } catch (_err) {
    throw new ApiError('INTERNAL_ERROR', 'Stellar SDK is unavailable');
  }

  const required = [
    Boolean(sdk && sdk.WebAuth),
    typeof sdk?.WebAuth?.buildChallengeTx === 'function',
    typeof sdk?.Keypair?.fromSecret === 'function',
    Boolean(sdk?.StrKey),
  ];
  if (verify) {
    required.push(
      typeof sdk?.WebAuth?.readChallengeTx === 'function',
      typeof sdk?.WebAuth?.verifyChallengeTxSigners === 'function',
      typeof sdk?.WebAuth?.verifyChallengeTxThreshold === 'function',
    );
  }
  if (required.some((ok) => !ok)) {
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

function validateTokenBody(body) {
  const parsed = sep10TokenBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error && parsed.error.issues && parsed.error.issues[0];
    throw invalid(issue && issue.message ? issue.message : 'Invalid challenge request');
  }
  return parsed.data;
}

const isAccountNotFound = (error) => {
  const status = Number(error?.response?.status ?? error?.status ?? error?.statusCode);
  return status === 404 || /account not found/i.test(String(error?.message || ''));
};

function clientDomainFromTransaction(tx) {
  const operation = (tx && Array.isArray(tx.operations)
    ? tx.operations
    : []
  ).find((op) => op && op.name === 'client_domain');

  if (!operation || operation.value === undefined || operation.value === null) return null;

  const value = Buffer.isBuffer(operation.value)
    ? operation.value.toString('utf8')
    : String(operation.value);
  return value.trim() || null;
}

/**
 * Verifies a signed SEP-10 challenge and exchanges it for a JWT.
 *
 * Dependencies are injectable so tests can supply a fake SDK/Horizon/JWT
 * signer. Production uses the real helpers lazily.
 */
async function verifySep10Challenge(body, redisClient, env = process.env, deps = {}) {
  const config = getSep10Config(env);
  if (!config.enabled) {
    throw new ApiError('NOT_FOUND', 'SEP-10 is not enabled');
  }
  if (
    !redisClient ||
    typeof redisClient.get !== 'function' ||
    typeof redisClient.del !== 'function'
  ) {
    throw new ApiError('SERVICE_UNAVAILABLE', 'Redis is not configured');
  }

  const { transaction } = validateTokenBody(body);
  const hash = challengeHash(transaction);
  const key = `${CHALLENGE_KEY_PREFIX}${hash}`;

  // The hash must have been recorded by GET /auth and not consumed already.
  let stored;
  try {
    stored = await redisClient.get(key);
  } catch (err) {
    throw new ApiError('SERVICE_UNAVAILABLE', 'Redis is unavailable', { cause: err });
  }
  if (!stored || stored !== hash) {
    throw new ApiError('INVALID_INPUT', 'Invalid or expired challenge');
  }

  const sdk = deps.sdk || loadSdk({ verify: true });

  let verification;
  try {
    verification = sdk.WebAuth.readChallengeTx(
      transaction,
      config.signingKey,
      config.networkPassphrase,
      config.homeDomain,
      config.webAuthDomain,
    );
  } catch (err) {
    // One generic message for every structural/signature check so a caller
    // cannot learn which validation rule failed.
    throw new ApiError('INVALID_INPUT', 'Invalid challenge transaction', { cause: err });
  }

  const clientAccountID = verification.clientAccountID;
  const memo = verification.memo == null ? null : String(verification.memo);
  const clientDomain = clientDomainFromTransaction(verification.tx);

  // Required at call time (not module load) so a disabled SEP-10 setup does
  // not pull in the Horizon SDK. `deps` lets callers inject the helper.
  const loadAccount = deps.loadAccount || require('../services/stellarService').loadAccount;
  let account = null;
  try {
    account = await loadAccount(clientAccountID);
  } catch (err) {
    if (!isAccountNotFound(err)) {
      throw new ApiError('SERVICE_UNAVAILABLE', 'Horizon is unavailable', { cause: err });
    }
  }

  try {
    if (account) {
      const threshold = Number(account.thresholds?.med_threshold ?? 0);
      const signers = (Array.isArray(account.signers) ? account.signers : []).map((signer) => {
        const weight = Number(signer.weight);
        return { key: signer.key, weight: Number.isFinite(weight) ? weight : 0 };
      });

      sdk.WebAuth.verifyChallengeTxThreshold(
        transaction,
        config.signingKey,
        config.networkPassphrase,
        Number.isFinite(threshold) ? threshold : 0,
        signers,
        config.homeDomain,
        config.webAuthDomain,
      );
    } else {
      // An account that does not exist can only prove its own master key.
      sdk.WebAuth.verifyChallengeTxSigners(
        transaction,
        config.signingKey,
        config.networkPassphrase,
        [clientAccountID],
        config.homeDomain,
        config.webAuthDomain,
      );
    }
  } catch (err) {
    throw new ApiError('UNAUTHENTICATED', 'Invalid challenge signature', { cause: err });
  }

  // Consume the challenge only after all verification rules have passed.
  let deleted;
  try {
    deleted = await redisClient.del(key);
  } catch (err) {
    throw new ApiError('SERVICE_UNAVAILABLE', 'Redis is unavailable', { cause: err });
  }
  if (!deleted) {
    throw new ApiError('INVALID_INPUT', 'Invalid or expired challenge');
  }

  const signJwt = deps.signToken || require('../utils/jwt').signToken;
  const claims = {
    iss: config.webAuthEndpoint,
    sub: clientAccountID.startsWith('M') || !memo
      ? clientAccountID
      : `${clientAccountID}:${memo}`,
    jti: hash,
    home_domain: config.homeDomain,
    ...(clientDomain ? { client_domain: clientDomain } : {}),
  };

  let token;
  try {
    token = signJwt(claims, { expiresIn: config.jwtExpiry });
  } catch (err) {
    throw new ApiError('SERVICE_UNAVAILABLE', 'JWT signing is unavailable', { cause: err });
  }

  return { token };
}

module.exports = {
  createSep10Challenge,
  verifySep10Challenge,
  challengeHash,
  CHALLENGE_KEY_PREFIX,
};

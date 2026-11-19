'use strict';

/**
 * src/config/sep10.js
 *
 * Single source of truth for SEP-10 settings used by discovery (stellar.toml)
 * and, later, by the challenge/token endpoints.
 *
 * Design notes
 * ------------
 * - Opt-in. With no SEP10_SIGNING_SECRET the feature is off: no validation of
 *   the other variables, no SDK import, no crash. The server logs one info
 *   line at startup and stellar.toml stays exactly as it was.
 * - Fail closed. A malformed secret aborts startup instead of publishing a
 *   broken SIGNING_KEY. The error names the variable but never the value.
 * - Secret hygiene. Only the derived public key is returned. The secret stays
 *   inside this module and is never attached to the config object or logs.
 */

const { ApiError } = require('../errors');
const { sep10EnvSchema } = require('../schemas/sep10Schema');

const DEFAULT_CHALLENGE_TIMEOUT_SECONDS = 900;
const DEFAULT_JWT_EXPIRY = '24h';

// Used only if a future SDK build does not expose Networks (e.g. a test mock).
const FALLBACK_PASSPHRASES = Object.freeze({
  testnet: 'Test SDF Network ; September 2015',
  public: 'Public Global Stellar Network ; September 2015',
});

const configError = (message) =>
  new ApiError('INVALID_INPUT', `[sep10] ${message}`);

const disabledConfig = () => ({
  enabled: false,
  signingKey: null,
  homeDomain: null,
  webAuthDomain: null,
  webAuthEndpoint: null,
  challengeTimeoutSeconds: DEFAULT_CHALLENGE_TIMEOUT_SECONDS,
  jwtExpiry: DEFAULT_JWT_EXPIRY,
  networkPassphrase: null,
  network: null,
});

/**
 * Reads and validates SEP-10 configuration from the given environment.
 *
 * @param {NodeJS.ProcessEnv} [env] injectable for unit tests
 * @returns {{
 *   enabled: boolean, signingKey: string|null, homeDomain: string|null,
 *   webAuthDomain: string|null, webAuthEndpoint: string|null,
 *   challengeTimeoutSeconds: number, jwtExpiry: string,
 *   networkPassphrase: string|null, network: string|null
 * }}
 * @throws {ApiError} with a secret-free message when an enabled setting is bad
 */
function getSep10Config(env = process.env) {
  const secret = env && env.SEP10_SIGNING_SECRET;
  const hasSecret = typeof secret === 'string' && secret.trim() !== '';

  // SEP-10 off: deliberately do not parse the rest of the environment. A stale
  // or half-configured set of SEP10_* variables must not change existing boots.
  if (!hasSecret) return disabledConfig();

  const parsed = sep10EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error && parsed.error.issues && parsed.error.issues[0];
    const field = issue && issue.path.length ? String(issue.path[0]) : 'configuration';
    const detail = issue ? issue.message : 'invalid value';
    // Never include the rejected value: it may be SEP10_SIGNING_SECRET itself.
    throw configError(`Invalid ${field}: ${detail}.`);
  }

  const values = parsed.data;

  let sdk;
  try {
    // Loaded lazily so the disabled path has no SDK dependency at all.
    sdk = require('@stellar/stellar-sdk');
  } catch (_err) {
    throw configError('@stellar/stellar-sdk is required to validate SEP10_SIGNING_SECRET.');
  }

  let keypair;
  try {
    keypair = sdk.Keypair.fromSecret(values.SEP10_SIGNING_SECRET);
  } catch (_err) {
    throw configError(
      'SEP10_SIGNING_SECRET must be a valid Stellar secret key starting with "S". The value was not logged.',
    );
  }
  if (!keypair || typeof keypair.publicKey !== 'function') {
    throw configError('SEP10_SIGNING_SECRET could not be converted to a public key.');
  }

  // SEP-1/SEP-10 discovery needs a home domain to publish. STELLAR_TAG_DOMAIN
  // is the existing default for federation, so reuse it unless overridden.
  const homeDomain = values.SEP10_HOME_DOMAIN || values.STELLAR_TAG_DOMAIN;
  if (!homeDomain) {
    throw configError(
      'SEP10_HOME_DOMAIN (or STELLAR_TAG_DOMAIN) is required when SEP-10 is enabled.',
    );
  }

  // The auth endpoint may live on a sub-domain of the home domain; SEP-10
  // allows the server domain to differ from the home domain.
  const webAuthDomain = values.SEP10_WEB_AUTH_DOMAIN || homeDomain;
  const network = values.HORIZON_NETWORK;
  const networkPassphrase = network === 'public'
    ? (sdk.Networks && sdk.Networks.PUBLIC) || FALLBACK_PASSPHRASES.public
    : (sdk.Networks && sdk.Networks.TESTNET) || FALLBACK_PASSPHRASES.testnet;

  return {
    enabled: true,
    signingKey: keypair.publicKey(),
    homeDomain,
    webAuthDomain,
    webAuthEndpoint: `https://${webAuthDomain}/auth`,
    challengeTimeoutSeconds: values.SEP10_CHALLENGE_TIMEOUT_SECONDS,
    jwtExpiry: values.SEP10_JWT_EXPIRY,
    networkPassphrase,
    network,
  };
}

module.exports = {
  getSep10Config,
  DEFAULT_CHALLENGE_TIMEOUT_SECONDS,
  DEFAULT_JWT_EXPIRY,
};

'use strict';

const { z } = require('zod');

/**
 * Environment schema for SEP-10 discovery settings.
 *
 * Every variable is optional at this layer: an unset signing secret means the
 * feature is off, and in that case `getSep10Config()` skips validation entirely
 * so a partial/legacy environment cannot break the server. When SEP-10 is on,
 * these refinements produce clear errors without ever echoing the secret value.
 */

const emptyToUndefined = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '')
    ? undefined
    : value;

// A bare hostname: SEP-10 discovery URLs are built from these values, so a
// scheme, path, port or whitespace would produce a malformed stellar.toml.
const hostname = z
  .string()
  .trim()
  .max(253, 'must be at most 253 characters')
  .regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/,
    'must be a bare hostname without scheme, path, port or whitespace',
  );

const positiveDuration = z
  .string()
  .trim()
  .regex(/^\d+(?:ms|s|m|h|d|w|y)?$/, 'must be a duration such as 900s, 15m or 24h')
  .refine((value) => parseInt(value, 10) > 0, 'must be greater than zero');

const challengeTimeout = z.preprocess((value) => {
  const cleaned = emptyToUndefined(value);
  if (cleaned === undefined) return 900;
  const text = String(cleaned).trim();
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}, z.number().int('must be a whole number').min(1, 'must be at least 1 second').max(86400, 'must be at most 86400 seconds'));

const sep10EnvSchema = z.object({
  SEP10_SIGNING_SECRET: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  SEP10_HOME_DOMAIN: z.preprocess(emptyToUndefined, hostname.optional()),
  SEP10_WEB_AUTH_DOMAIN: z.preprocess(emptyToUndefined, hostname.optional()),
  SEP10_CHALLENGE_TIMEOUT_SECONDS: challengeTimeout,
  SEP10_JWT_EXPIRY: z.preprocess((value) => emptyToUndefined(value) ?? '24h', positiveDuration),
  HORIZON_NETWORK: z.preprocess(
    (value) => emptyToUndefined(value) ?? 'testnet',
    z.enum(['testnet', 'public'], 'must be "testnet" or "public"'),
  ),
  STELLAR_TAG_DOMAIN: z.preprocess(emptyToUndefined, hostname.optional()),
});

module.exports = { sep10EnvSchema, emptyToUndefined };

'use strict';

/**
 * #685 — Per-request GraphQL context.
 *
 * Built once per HTTP request and handed to every resolver. It carries the
 * Prisma client, the request-scoped DataLoaders, and the caller's identity.
 *
 * Two ways to prove who you are, both already used by the REST layer:
 *
 *   - `Authorization: Bearer <RS256 JWT>` — verified with the same public key
 *     as `requireAuth`. A bad or missing key simply yields no identity; it is
 *     not an error until a resolver actually needs one, so public queries keep
 *     working with a stale token in the header.
 *   - `X-Stellar-Signature` (+ optional `X-Stellar-Signer`) together with
 *     `X-Stellar-Tags-Username` — the signature-over-`operation:username`
 *     scheme the webhook and activity endpoints already accept, delegated to
 *     `authenticateUsernameOwner` so there is one implementation of it.
 */

const { prisma: sharedPrisma } = require('../../prismaClient');
const { verifyToken } = require('../utils/jwt');
const { authenticateUsernameOwner } = require('../services/ownershipService');
const { ApiError } = require('../errors');
const { createLoaders } = require('./loaders');
const { normalizeUsername } = require('./resolvers/helpers');

const BEARER_PREFIX = /^Bearer\s+/i;

const firstHeader = (req, name) => {
  const raw = req?.headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * Reads the caller's identity from the request, if any.
 *
 * @returns {{ claims: object }|null} null when the request is unauthenticated
 *   or the token is not usable.
 */
function resolveViewer(req) {
  const header = firstHeader(req, 'authorization');
  if (!BEARER_PREFIX.test(header)) return null;

  const token = header.replace(BEARER_PREFIX, '').trim();
  if (!token) return null;

  try {
    return { claims: verifyToken(token) };
  } catch {
    // An unverifiable token is treated as no token. Resolvers that require
    // identity raise UNAUTHENTICATED, which is the same outcome a client gets
    // from REST without a token.
    return null;
  }
}

/** The username a JWT claims to own, if any. */
const viewerUsername = (viewer) => {
  const claims = viewer?.claims;
  if (!claims) return null;
  const candidate = claims.username || claims.preferred_username || claims.sub;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
};

/**
 * Proves the caller controls `username`.
 *
 * A JWT is accepted when its subject matches the requested username. Otherwise
 * the Stellar signature headers are required, verified against the account
 * registered for that username.
 *
 * @param {object} context - the request context
 * @param {string} username - the account being accessed
 * @param {string} operation - operation string bound into the signature
 *   (`webhook` or `activity`), matching the REST endpoints.
 * @returns {Promise<{username: string, address: string}>}
 */
async function requireUsernameOwner(context, username, operation) {
  const requested = typeof username === 'string' ? username.trim() : '';
  if (!requested) {
    throw new ApiError('INVALID_INPUT', 'Missing username argument.');
  }

  const normalized = normalizeUsername(requested);
  const fromJwt = viewerUsername(context.viewer);
  if (fromJwt) {
    if (normalizeUsername(fromJwt) !== normalized) {
      throw new ApiError(
        'FORBIDDEN',
        'The authenticated account does not own this username.',
      );
    }
    return { username: normalized, address: context.viewer.claims.address ?? null };
  }

  const signature = firstHeader(context.req, 'x-stellar-signature');
  const signerAddress = firstHeader(context.req, 'x-stellar-signer') || undefined;
  if (!signature) {
    throw new ApiError(
      'UNAUTHENTICATED',
      'Provide a Bearer token, or the X-Stellar-Signature and X-Stellar-Signer headers to prove ownership.',
    );
  }

  return authenticateUsernameOwner({
    username: requested,
    signature,
    signerAddress,
    operation,
  });
}

/**
 * The username whose webhooks the caller is asking for. There is no username
 * argument on `Query.webhooks` (that mirrors `GET /webhooks`, which takes the
 * username as part of the signed payload), so it is read from a header.
 */
function requireWebhookOwnerUsername(context) {
  const fromJwt = viewerUsername(context.viewer);
  const fromHeader = firstHeader(context.req, 'x-stellar-tags-username');
  const requested = (fromHeader || fromJwt || '').trim();
  if (!requested) {
    throw new ApiError(
      'UNAUTHENTICATED',
      'Set the X-Stellar-Tags-Username header (or use a Bearer token) to list webhooks.',
    );
  }
  return requested;
}

/**
 * Build the context for one request.
 *
 * @param {object} options
 * @param {object} options.req - the Express request.
 * @param {object} [options.prisma] - overrides the shared client (tests).
 * @param {object} [options.redisClient] - used by the cached stats resolver.
 * @param {Function} [options.poolGet] - used by the stats fallback path.
 * @returns {object} context
 */
function createContext({ req, prisma = sharedPrisma, redisClient = null, poolGet = null }) {
  return {
    req,
    prisma,
    redisClient,
    poolGet,
    loaders: createLoaders(prisma),
    viewer: resolveViewer(req),
    requireUsernameOwner,
    requireWebhookOwnerUsername,
    correlationId: firstHeader(req, 'x-correlation-id') || null,
  };
}

module.exports = {
  createContext,
  resolveViewer,
  viewerUsername,
  requireUsernameOwner,
  requireWebhookOwnerUsername,
  firstHeader,
};

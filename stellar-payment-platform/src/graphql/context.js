'use strict';

const { prisma } = require('../../prismaClient');
const { logger } = require('../logger');
const {
  lookupCached,
  federationLookupCached,
  federationNameKey,
  federationIdKey,
  invalidateFederationCache,
} = require('../cache');

/**
 * Builds the GraphQL execution context for every request.
 *
 * The context is the single channel through which request-scoped concerns
 * (authentication, correlation id) and shared infrastructure (the Prisma
 * client, the in-memory cache helpers) reach the resolvers. Resolvers never
 * reach back into the Express request object directly; everything they need is
 * placed on the context here.
 *
 * Authentication model:
 *   - `isAdmin` is true when the request carries the configured admin API key
 *     (x-api-key header or api_key query), mirroring the REST adminAuth
 *     middleware. Admin-gated resolvers check this and refuse otherwise.
 *   - Per-user operations that mutate data the user owns (webhooks) authenticate
 *     with a wallet signature supplied as mutation arguments and verified in
 *     the resolver against the registered account.
 *
 * @param {{ req: import('express').Request }} expressContext
 * @returns {object} resolver context
 */
function buildContext({ req }) {
  const apiKey =
    (req.headers && req.headers['x-api-key']) ||
    (req.query && req.query.api_key) ||
    null;

  const isAdmin = Boolean(
    apiKey && process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY,
  );

  return {
    prisma,
    apiKey,
    isAdmin,
    correlationId: req.correlationId || null,
    // Cache helpers are exposed so resolvers reuse the same federation cache
    // the REST handlers use, keeping invalidation consistent across both APIs.
    cache: {
      lookupCached,
      federationLookupCached,
      federationNameKey,
      federationIdKey,
      invalidateFederationCache,
    },
    logger,
    req,
  };
}

module.exports = { buildContext };

'use strict';

/**
 * Apollo Server context factory for the Stellar Payment Platform.
 *
 * Called once per request.  Attaches shared resources (prisma, logger) and
 * any authenticated identity derived from request headers.
 *
 * Authentication is opt-in per resolver: resolvers that need a verified caller
 * check \`context.verifiedAddress\` (or throw UNAUTHENTICATED when absent).
 * Most read-only queries work without authentication.
 *
 * Header contract:
 *   x-stellar-address   — the caller's Stellar public key
 *   x-stellar-signature — base64-encoded Ed25519 signature over the message
 *                          "<operation>:<username>" where operation defaults to
 *                          "graphql"
 *
 * Signature verification is deferred to individual resolvers that need it so
 * that unauthenticated queries (e.g. `user`, `federation`) never pay the cost.
 */

const { prisma } = require('../../prismaClient');
const { logger } = require('../logger');

/**
 * Build the GraphQL context object.
 *
 * @param {{ req: import('express').Request }} param0
 * @returns {GraphQLContext}
 */
async function buildContext({ req }) {
  const correlationId =
    req.correlationId ||
    req.headers['x-correlation-id'] ||
    null;

  // Extract identity headers without performing signature verification here.
  // Resolvers that need verified callers call `requireAuth(context)`.
  const stellarAddress =
    typeof req.headers['x-stellar-address'] === 'string'
      ? req.headers['x-stellar-address'].trim()
      : null;

  const stellarSignature =
    typeof req.headers['x-stellar-signature'] === 'string'
      ? req.headers['x-stellar-signature'].trim()
      : null;

  return {
    /** Prisma client — shared, already-initialised instance */
    prisma,
    /** Logger with correlation context baked in */
    logger: logger.child ? logger.child({ correlationId }) : logger,
    /** Correlation ID from the Express middleware (or header fallback) */
    correlationId,
    /** Raw Stellar public key from the request header — NOT yet verified */
    stellarAddress,
    /** Raw signature from the request header — NOT yet verified */
    stellarSignature,
    /** The raw Express request, available for resolvers that need it */
    req,
  };
}

/**
 * Throws a GraphQL-compatible UNAUTHENTICATED error when the request does not
 * carry a Stellar address header.  Call this at the top of any resolver that
 * requires an authenticated caller.
 *
 * Full signature verification is handled by the individual resolver because
 * the required message payload depends on the operation being performed.
 *
 * @param {GraphQLContext} context
 * @returns {string} The validated stellarAddress
 */
function requireAuthHeader(context) {
  if (!context.stellarAddress) {
    const { GraphQLError } = require('graphql');
    throw new GraphQLError('Authentication required: provide x-stellar-address header', {
      extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
    });
  }
  return context.stellarAddress;
}

module.exports = { buildContext, requireAuthHeader };

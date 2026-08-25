'use strict';

/**
 * GraphQL context builder.
 *
 * Called once per request by the Apollo Server Express integration.
 * It extracts the caller's identity from the request and exposes it to every
 * resolver through the shared `context` object.
 *
 * Authentication is opt-in: most queries are public.  Mutations that require
 * ownership (webhooks) run their own per-resolver auth checks using the
 * signature fields in their input arguments — this is identical to how the
 * REST endpoints work.
 *
 * The context carries:
 *   stellarAddress {string|null}   - Stellar public key from X-Stellar-Address header,
 *                                    only present when the caller explicitly supplies it.
 *   correlationId  {string|null}   - Forwarded from the correlation-ID middleware so
 *                                    resolvers can attach it to log entries.
 *   req            {express.Request} - The raw Express request (useful for advanced
 *                                    middleware that writes to req).
 */

/**
 * Build the Apollo context object from the Express request.
 *
 * @param {{ req: import('express').Request }} param0
 * @returns {{ stellarAddress: string|null, correlationId: string|null, req: import('express').Request }}
 */
const buildContext = ({ req }) => {
  // X-Stellar-Address is a convention used by some Stellar wallet integrations
  // to declare which account the request is acting on behalf of.  Resolvers
  // that need to gate access on the caller's identity (e.g. the User.webhooks
  // field resolver) read this value from context.
  const rawAddress = req.headers['x-stellar-address'];
  const stellarAddress =
    typeof rawAddress === 'string' && rawAddress.trim().length > 0
      ? rawAddress.trim()
      : null;

  // correlationId is set by the correlation middleware (middleware/correlation.js)
  const correlationId = req.correlationId ?? null;

  return { stellarAddress, correlationId, req };
};

module.exports = { buildContext };

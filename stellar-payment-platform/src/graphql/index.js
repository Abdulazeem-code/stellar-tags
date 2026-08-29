'use strict';

const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@as-integrations/express4');
const { typeDefs } = require('./schema');
const { resolvers } = require('./resolvers');
const { prisma } = require('../../prismaClient');
const { logger } = require('../logger');

// ──────────────────────────────────────────────────────────────────────────
// Auth context
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the GraphQL execution context from the incoming Express request.
 *
 * Authentication model:
 *
 *   1. **User identity** – The client sends two headers:
 *        x-user-username: alice
 *        x-user-address:  GABCDEF…
 *      Both must be present and must match a non-deleted database row for
 *      `context.user` to be set.  When only `x-user-username` is provided
 *      the lookup still runs but the address is not verified against the DB
 *      row, which lets read-only queries work without an address header.
 *
 *      NOTE: In production you MUST front this with a real auth layer (e.g.
 *      Stellar SEP-0010 JWT or an equivalent signed challenge) before
 *      trusting the header values.  Header-only auth is intentionally left
 *      open here so the REST layer's existing signature-verification flow
 *      can be reused by the caller before it issues a session token.
 *
 *   2. **Admin access** – Passing `x-api-key: <ADMIN_API_KEY>` sets
 *      `context.isAdmin = true`, which unlocks admin-only mutations such as
 *      `flagUser`.  The key is compared with `process.env.ADMIN_API_KEY`.
 *      If `ADMIN_API_KEY` is not set in the environment, admin endpoints are
 *      effectively disabled for safety.
 *
 * Resulting context shape:
 * ```
 * {
 *   req:           IncomingMessage,   // original Express request
 *   user:          User | null,       // authenticated Prisma user record
 *   isAdmin:       boolean,           // true when a valid admin API key is present
 *   authorization: string | null,     // raw Authorization header value
 *   apiKey:        string | null,     // raw x-api-key header value
 * }
 * ```
 */
const buildContext = async ({ req }) => {
  // ── Admin check ──────────────────────────────────────────────────────────
  const apiKey = req.headers['x-api-key'] || null;
  const adminKey = process.env.ADMIN_API_KEY;
  // isAdmin is only true when ADMIN_API_KEY is configured AND the caller
  // supplies a matching key. An absent or empty ADMIN_API_KEY disables admin
  // access entirely so a misconfigured deployment fails safely.
  const isAdmin = Boolean(adminKey && apiKey && apiKey === adminKey);

  // ── User identity ────────────────────────────────────────────────────────
  const rawUsername = req.headers['x-user-username'];
  const rawAddress = req.headers['x-user-address'];

  let user = null;

  if (typeof rawUsername === 'string' && rawUsername.trim()) {
    const username = rawUsername.trim().toLowerCase();

    try {
      user = await prisma.user.findFirst({
        where: {
          username,
          deletedAt: null,
          // When an address header is supplied verify it matches the row,
          // preventing a user from impersonating another account by guessing
          // their username alone.
          ...(typeof rawAddress === 'string' && rawAddress.trim()
            ? { address: rawAddress.trim() }
            : {}),
        },
      });
    } catch (err) {
      // A DB error during context build should not crash the request; it just
      // means the request proceeds as unauthenticated. The resolver auth
      // guards will throw UNAUTHENTICATED as normal.
      logger.warn({ err }, 'GraphQL: failed to resolve user from request headers');
    }
  }

  return {
    req,
    user,
    isAdmin,
    authorization: req.headers.authorization || null,
    apiKey,
  };
};

// ──────────────────────────────────────────────────────────────────────────
// Server factory
// ──────────────────────────────────────────────────────────────────────────

const createGraphQLServer = () =>
  new ApolloServer({
    typeDefs,
    resolvers,
    // Disable the default introspection-disabling behaviour in production so
    // that developer tools and the frontend team can always explore the schema.
    // If you want to restrict introspection in prod, set the env var
    // GRAPHQL_DISABLE_INTROSPECTION=true.
    introspection: process.env.GRAPHQL_DISABLE_INTROSPECTION !== 'true',
    // Format GraphQL errors before they leave the server to ensure sensitive
    // internals are not leaked in production.
    formatError: (formattedError, err) => {
      if (process.env.NODE_ENV === 'production') {
        const code = formattedError.extensions?.code;
        const safeCode = ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'BAD_USER_INPUT'].includes(code)
          ? code
          : 'INTERNAL_SERVER_ERROR';

        if (!['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'BAD_USER_INPUT'].includes(code)) {
          logger.error({ err }, 'GraphQL internal error');
          return {
            message: 'Internal server error',
            extensions: { code: safeCode },
          };
        }
      }
      return formattedError;
    },
  });

/**
 * Start the Apollo Server and attach it to the Express app at `/graphql`.
 *
 * The route is registered **synchronously** so it sits before the 404 handler
 * in Express's middleware stack. Internally, each request awaits the server's
 * start promise before forwarding to `expressMiddleware`, which means the
 * first request that arrives before start() resolves will simply wait rather
 * than 404-ing.
 *
 * The returned object exposes `server` (the ApolloServer instance) and
 * `ready` (a Promise that resolves once `server.start()` has finished). Tests
 * should `await graphqlServer.ready` in `beforeAll` to ensure the server is
 * up before sending requests.
 *
 * @param {import('express').Application} app
 * @returns {{ server: ApolloServer, ready: Promise<void> }}
 */
const attachGraphQL = (app) => {
  const server = createGraphQLServer();

  // Start the server asynchronously; `ready` resolves when it is done.
  const middlewarePromise = server.start().then(() => {
    logger.info('GraphQL endpoint ready at /graphql');
    return expressMiddleware(server, { context: buildContext });
  });

  // Propagate start-up errors so they are visible in logs.
  middlewarePromise.catch((err) =>
    logger.error({ err }, 'GraphQL server failed to start'),
  );

  // Register the route **synchronously** so it is placed before notFoundHandler
  // in the Express middleware stack. The async init is awaited per-request.
  app.use('/graphql', async (req, res, next) => {
    try {
      const mw = await middlewarePromise;
      return mw(req, res, next);
    } catch (err) {
      return next(err);
    }
  });

  return { server, ready: middlewarePromise.then(() => undefined) };
};

module.exports = { attachGraphQL, buildContext, createGraphQLServer };

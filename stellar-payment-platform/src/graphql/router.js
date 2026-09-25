'use strict';

/**
 * #685 — Express wiring for the GraphQL endpoint.
 *
 * Mounts a single `/graphql` route that serves three things:
 *
 *   - `POST /graphql` (and `GET` with `?query=`) executes operations;
 *   - `GET /graphql` with no query serves the development playground;
 *   - anything else falls through to the app's normal 404 handling.
 *
 * The path is registered on the app with `app.all` rather than through a
 * `Router`, because the GraphQL handler reads the request URL to find the
 * `?query=` / `?variables=` parameters and mounting through a Router would
 * strip the prefix it needs.
 */

const { createHandler } = require('graphql-http/lib/use/express');
const { makeSchema } = require('./schema');
const { typeDefs } = require('./typeDefs');
const resolvers = require('./resolvers');
const { createContext } = require('./context');
const { playgroundHtml, playgroundPolicy } = require('./playground');
const { ApiError, ERROR_CODES, DEFAULT_MESSAGES, codeForStatus } = require('../errors');
const { logger } = require('../logger');

const GRAPHQL_PATH = '/graphql';

const isProduction = () =>
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

/**
 * The playground is on by default outside production and always off inside it.
 * `GRAPHQL_PLAYGROUND=0` disables it explicitly; `=1` forces it on.
 */
const isPlaygroundEnabled = () => {
  if (isProduction()) return false;
  const flag = String(process.env.GRAPHQL_PLAYGROUND ?? '').trim().toLowerCase();
  if (!flag) return true;
  return !['0', 'false', 'off', 'no'].includes(flag);
};

/**
 * Whether the error was authored rather than incidental.
 *
 * `ApiError` covers everything thrown inside `src/`, but the code this endpoint
 * leans on for ownership checks (`authenticateUsernameOwner`) throws a plain
 * `Error` carrying only a status code. Those 4xx messages are the actionable
 * part of the auth contract — "Signature verification failed" is exactly what
 * the caller needs to know — so they are treated as authored, matching how
 * `errorHandler` decides what to show for the same errors over REST.
 */
const isExpectedError = (error) =>
  error instanceof ApiError ||
  (typeof error?.code === 'string' && error.code in ERROR_CODES) ||
  (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500);

/** Maps a resolved error onto the platform's code vocabulary. */
const resolveCode = (error) => {
  if (typeof error?.code === 'string' && error.code in ERROR_CODES) return error.code;
  if (typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code)) return error.code;
  return codeForStatus(error?.statusCode || 500);
};

/**
 * Error formatter.
 *
 * `maskedErrors` is deliberately left off: it rewrites every message, which
 * would also hide the authored `ApiError` messages that carry the actionable
 * part. Only incidental errors are masked, and only in production, using the
 * same code and message the REST error handler would send for them.
 *
 * graphql-http calls this with the error alone, so the correlation id is not
 * available here — it is on the `X-Correlation-ID` response header instead,
 * which the app's correlation middleware sets for every request.
 */
const formatError = (error) => {
  const original = error?.originalError || error;
  const expected = isExpectedError(original);
  const masked = isProduction() && !expected;
  const code = expected ? resolveCode(original) : 'INTERNAL_ERROR';

  if (!expected) {
    logger.error(
      { err: original, path: error?.path, locations: error?.locations },
      '[graphql] unexpected resolver error',
    );
  }

  return {
    message: masked ? DEFAULT_MESSAGES.INTERNAL_ERROR : error.message,
    ...(error?.locations && { locations: error.locations }),
    ...(error?.path && { path: error.path }),
    extensions: {
      code,
      statusCode: original?.statusCode || ERROR_CODES[code] || 500,
      // Details can echo the input that caused the failure, so they ride along
      // only when the error itself is safe to show.
      ...(expected && original?.details ? { details: original.details } : {}),
    },
  };
};

/** Builds the executable schema. Exposed so tests can execute against it directly. */
const createSchema = () => makeSchema({ typeDefs, resolvers });

const hasQuery = (req) => {
  const value = req?.query?.query;
  return typeof value === 'string' && value.trim().length > 0;
};

/**
 * Register the GraphQL endpoint on an Express app.
 *
 * @param {import('express').Application} app
 * @param {object} deps
 * @param {object} deps.prisma - Prisma client.
 * @param {object} [deps.redisClient] - used by the cached stats resolver.
 * @param {Function} [deps.poolGet] - used by the stats fallback path.
 * @param {string} [deps.path] - endpoint path.
 * @returns {{ schema: object, path: string }}
 */
function registerGraphQL(app, { prisma, redisClient = null, poolGet = null, path = GRAPHQL_PATH } = {}) {
  const schema = createSchema();

  const handler = createHandler({
    schema,
    context: (req) => createContext({ req, prisma, redisClient, poolGet }),
    formatError,
    maskedErrors: false,
  });

  app.all(path, (req, res, next) => {
    if (req.method !== 'GET' || hasQuery(req)) {
      return handler(req, res, next);
    }

    if (!isPlaygroundEnabled()) return next();

    res.setHeader('Content-Security-Policy', playgroundPolicy());
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(playgroundHtml(path));
  });

  logger.info(`[graphql] endpoint mounted at ${path}`);

  return { schema, path };
}

module.exports = {
  registerGraphQL,
  createSchema,
  formatError,
  isExpectedError,
  isPlaygroundEnabled,
  isProduction,
  hasQuery,
  GRAPHQL_PATH,
};

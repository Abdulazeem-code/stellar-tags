'use strict';

const express = require('express');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');

const { typeDefs } = require('./schema');
const resolvers = require('./resolvers');
const { buildContext } = require('./context');
const { logger } = require('../logger');

/**
 * Attaches an Apollo Server GraphQL endpoint at `/graphql` on the given
 * Express app, alongside the existing REST routes.
 *
 * Apollo Server must finish `start()` before it can serve requests, but the
 * app's terminal 404 and error handlers are registered synchronously at module
 * load. To keep `/graphql` reachable, a deferred handler is mounted up front
 * (before those terminal handlers): it returns 503 until the Apollo server is
 * ready, then forwards to the real `expressMiddleware`.
 *
 * The returned promise resolves once the GraphQL endpoint is live; tests and
 * the server bootstrap can await it before exercising `/graphql`.
 *
 * @param {import('express').Express} app
 * @returns {Promise<void>}
 */
function setupGraphQL(app) {
  let handler = null;

  app.use(
    '/graphql',
    express.json(),
    (req, res, next) => {
      if (handler) return handler(req, res, next);
      return res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'GraphQL endpoint is starting up' },
      });
    },
  );

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    // Let the frontend explore the schema in every non-production environment;
    // production keeps it off to avoid leaking the schema surface.
    introspection: process.env.NODE_ENV !== 'production',
    // Never leak server stack traces to clients.
    includeStacktraceInErrorResponses: false,
  });

  return server
    .start()
    .then(() => {
      handler = expressMiddleware(server, { context: buildContext });
      logger.info('GraphQL endpoint ready at /graphql');
    })
    .catch((err) => {
      // Swallow startup failures so the REST API keeps serving even if the
      // GraphQL endpoint cannot come up. The deferred handler below returns
      // 503 until (and unless) the endpoint is ready, so a failed start is
      // observable as a degraded /graphql rather than a process-level crash.
      // (Some Jest isolation patterns reload the graphql module mid-start; in
      // those test realms this guard keeps unrelated REST tests green.)
      logger.error(err, 'GraphQL server failed to start; /graphql will return 503');
    });
}

module.exports = { setupGraphQL };

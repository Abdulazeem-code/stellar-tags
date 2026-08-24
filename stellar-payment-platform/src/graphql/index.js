'use strict';

/**
 * Apollo Server 4 setup for the Stellar Payment Platform.
 *
 * Exports a factory that builds and starts the ApolloServer, then returns the
 * Express middleware produced by \`expressMiddleware\` from
 * \`@apollo/server/express4\`.
 *
 * Usage in server.js:
 *
 *   const { createGraphQLMiddleware } = require('./src/graphql');
 *   // ...after app is configured but before app.listen:
 *   const graphqlMiddleware = await createGraphQLMiddleware(corsOptions);
 *   app.use('/graphql', express.json(), graphqlMiddleware);
 */

const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const {
  ApolloServerPluginDrainHttpServer,
} = require('@apollo/server/plugin/drainHttpServer');
const { typeDefs } = require('./typeDefs');
const { resolvers } = require('./resolvers');
const { buildContext } = require('./context');
const { logger } = require('../logger');

/**
 * Build, start, and return the Apollo `expressMiddleware`.
 *
 * @param {object} options
 * @param {import('http').Server} [options.httpServer] - Pass the HTTP server to
 *   enable the drain plugin (graceful shutdown on SIGTERM).  Optional in test
 *   environments where no HTTP server exists yet.
 * @param {object} [options.corsOptions] - CORS configuration forwarded to
 *   `expressMiddleware`.  Defaults to the same allow-list used by the REST API.
 * @returns {Promise<import('express').RequestHandler>}
 */
async function createGraphQLMiddleware({ httpServer, corsOptions } = {}) {
  const plugins = [];

  if (httpServer) {
    plugins.push(ApolloServerPluginDrainHttpServer({ httpServer }));
  }

  // Disable the landing page in production to avoid leaking schema info.
  if (process.env.NODE_ENV === 'production') {
    const { ApolloServerPluginLandingPageDisabled } = require('@apollo/server/plugin/disabled');
    plugins.push(ApolloServerPluginLandingPageDisabled());
  }

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    plugins,
    // Surface original errors in development; mask internals in production.
    includeStacktraceInErrorResponses: process.env.NODE_ENV !== 'production',
    formatError(formattedError, error) {
      // Log every server-side error so it ends up in the application log file.
      if (
        formattedError.extensions?.code === 'INTERNAL_SERVER_ERROR' ||
        formattedError.extensions?.http?.status >= 500
      ) {
        logger.error(
          { err: error, code: formattedError.extensions?.code },
          '[graphql] server error',
        );
      }
      return formattedError;
    },
  });

  await server.start();

  logger.info('[graphql] Apollo Server started — endpoint: /graphql');

  return expressMiddleware(server, {
    cors: corsOptions || false, // CORS is already handled by the outer Express middleware
    context: buildContext,
  });
}

module.exports = { createGraphQLMiddleware };

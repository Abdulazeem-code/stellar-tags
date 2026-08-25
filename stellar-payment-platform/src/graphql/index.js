'use strict';

const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@as-integrations/express4');
const { ApolloServerPluginDrainHttpServer } = require('@apollo/server/plugin/drainHttpServer');
const { ApolloServerPluginLandingPageDisabled } = require('@apollo/server/plugin/disabled');
const { ApolloServerPluginLandingPageLocalDefault } = require('@apollo/server/plugin/landingPage/default');

const { typeDefs } = require('./typeDefs');
const { resolvers } = require('./resolvers');
const { buildContext } = require('./context');

/**
 * Create and start an Apollo Server instance, then attach it to the given
 * Express application at `path` (default `/graphql`).
 *
 * server.js registers a deferring placeholder middleware at /graphql before
 * notFoundHandler runs.  This function replaces that placeholder with the
 * real Apollo handler by calling `installGraphQLHandler` (exported by
 * server.js).  When used outside server.js (e.g. from a test that builds its
 * own app), the middleware is appended with `app.use(path, ...)` as normal.
 *
 * The function must be awaited before the Express `app.listen` call so that
 * Apollo can finish its internal startup sequence.  When `httpServer` is
 * provided the drain plugin will stop accepting new GraphQL requests before
 * the HTTP server closes, enabling graceful shutdown.
 *
 * @param {object}   options
 * @param {import('express').Application} options.app          - Express app instance.
 * @param {import('http').Server}         [options.httpServer]  - Node HTTP server (enables drain plugin).
 * @param {string}                        [options.path]        - Mount path (default '/graphql').
 * @param {boolean}                       [options.introspection] - Enable introspection. Defaults to
 *                                                                   true in development, false in production.
 * @param {Function}                      [options.installHandler] - If provided, called with the built
 *                                                                    express middleware instead of app.use().
 *                                                                    Used by server.js to slot the handler
 *                                                                    into the pre-registered placeholder slot.
 * @returns {Promise<ApolloServer>} The started Apollo Server instance.
 */
const mountGraphQL = async ({ app, httpServer, path = '/graphql', introspection, installHandler } = {}) => {
  const isDev = process.env.NODE_ENV !== 'production';

  // Determine whether schema introspection is allowed.  Introspection lets
  // developers explore the schema via Apollo Sandbox or GraphiQL tools, but
  // exposes the full API surface in production.  Default: on in dev, off in prod.
  const enableIntrospection = introspection !== undefined ? introspection : isDev;

  const plugins = [
    // Show Apollo Sandbox landing page in development; silence it in production.
    isDev
      ? ApolloServerPluginLandingPageLocalDefault({ embed: false })
      : ApolloServerPluginLandingPageDisabled(),
  ];

  // Attach the drain plugin when a real HTTP server is available so graceful
  // shutdown works correctly (the plugin waits for in-flight requests to settle
  // before letting the process exit).
  if (httpServer) {
    plugins.push(ApolloServerPluginDrainHttpServer({ httpServer }));
  }

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    introspection: enableIntrospection,
    plugins,
    // Format errors before they are sent to the client.  We hide the stack
    // trace in production and surface the stable code extension instead.
    formatError: (formattedError) => {
      if (process.env.NODE_ENV === 'production') {
        // Strip stack traces in production — the code extension is enough.
        // eslint-disable-next-line no-unused-vars
        const { stacktrace, ...extensionsWithoutStack } = formattedError.extensions ?? {};
        return { ...formattedError, extensions: extensionsWithoutStack };
      }
      return formattedError;
    },
  });

  await server.start();

  // Build the Apollo express middleware.
  const middleware = expressMiddleware(server, {
    context: async ({ req }) => buildContext({ req }),
  });

  if (typeof installHandler === 'function') {
    // server.js pre-registers a deferring placeholder at /graphql so that
    // the path sits above notFoundHandler in the stack.  Replace the
    // placeholder with the real Apollo handler now that it's ready.
    installHandler(middleware);
  } else {
    // Standalone usage (tests with their own app, or external integrations):
    // append the middleware normally.
    app.use(path, middleware);
  }

  return server;
};

module.exports = { mountGraphQL };

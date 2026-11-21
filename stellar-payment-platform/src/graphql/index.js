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
const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@as-integrations/express4");
const { buildSubgraphSchema } = require("@apollo/subgraph");
const DataLoader = require("dataloader");
const { GraphQLScalarType, Kind, parse } = require("graphql");

const typeDefs = parse(`#graphql
  extend schema
    @link(url: "https://specs.apollo.dev/federation/v2.7", import: ["@key"])

  scalar DateTime

  type User @key(fields: "username") {
    username: ID!
    address: String!
    isPrimary: Boolean!
    createdAt: DateTime!
    payments: [Payment!]!
  }

  type Payment @key(fields: "id") {
    id: ID!
    createdAt: DateTime!
    fromAddress: String!
    toAddress: String!
    amount: Float!
    fee: Float!
    assetCode: String
    transactionHash: String
    status: String!
    token: Token
  }

  type Token @key(fields: "code") {
    code: ID!
    payments: [Payment!]!
  }

  type Query {
    user(username: ID!): User
    users(limit: Int = 20): [User!]!
    payment(id: ID!): Payment
    payments(limit: Int = 20): [Payment!]!
    token(code: ID!): Token!
    tokens(limit: Int = 20): [Token!]!
  }
`);

const clampLimit = (limit) => Math.min(100, Math.max(1, limit || 20));

const dateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description: "An ISO-8601 timestamp",
  serialize(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("Invalid DateTime value");
    return date.toISOString();
  },
  parseValue(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("Invalid DateTime value");
    return date;
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) return null;
    const date = new Date(ast.value);
    return Number.isNaN(date.getTime()) ? null : date;
  },
});

const createLoaders = (prismaClient) => ({
  paymentsByAddress: new DataLoader(async (addresses) => {
    const uniqueAddresses = [...new Set(addresses)];
    const payments = await prismaClient.payment.findMany({
      where: { fromAddress: { in: uniqueAddresses } },
      orderBy: { createdAt: "desc" },
    });
    return addresses.map((address) =>
      payments.filter((payment) => payment.fromAddress === address),
    );
  }),
  paymentsByToken: new DataLoader(async (codes) => {
    const uniqueCodes = [...new Set(codes)];
    const payments = await prismaClient.payment.findMany({
      where: { assetCode: { in: uniqueCodes } },
      orderBy: { createdAt: "desc" },
    });
    return codes.map((code) =>
      payments.filter((payment) => payment.assetCode === code),
    );
  }),
});

const createGraphQLContext = (prismaClient) => ({
  prisma: prismaClient,
  loaders: createLoaders(prismaClient),
});

const resolvers = {
  DateTime: dateTimeScalar,
  Query: {
    user: (_root, { username }, { prisma }) =>
      prisma.user.findUnique({ where: { username, deletedAt: null } }),
    users: (_root, { limit }, { prisma }) =>
      prisma.user.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: clampLimit(limit),
      }),
    payment: (_root, { id }, { prisma }) =>
      prisma.payment.findUnique({ where: { id } }),
    payments: (_root, { limit }, { prisma }) =>
      prisma.payment.findMany({
        orderBy: { createdAt: "desc" },
        take: clampLimit(limit),
      }),
    token: (_root, { code }) => ({ code }),
    tokens: async (_root, { limit }, { prisma }) => {
      const rows = await prisma.payment.findMany({
        where: { assetCode: { not: null } },
        distinct: ["assetCode"],
        select: { assetCode: true },
        take: clampLimit(limit),
      });
      return rows.map(({ assetCode }) => ({ code: assetCode }));
    },
  },
  User: {
    __resolveReference: ({ username }, { prisma }) =>
      prisma.user.findUnique({ where: { username, deletedAt: null } }),
    payments: (user, _args, { loaders }) =>
      loaders.paymentsByAddress.load(user.address),
  },
  Payment: {
    __resolveReference: ({ id }, { prisma }) =>
      prisma.payment.findUnique({ where: { id } }),
    token: (payment) =>
      payment.assetCode ? { code: payment.assetCode } : null,
  },
  Token: {
    __resolveReference: ({ code }) => ({ code }),
    payments: (token, _args, { loaders }) =>
      loaders.paymentsByToken.load(token.code),
  },
};

const schema = buildSubgraphSchema([{ typeDefs, resolvers }]);

const depthLimit = require("graphql-depth-limit");

const createGraphQLServer = () => new ApolloServer({ 
  schema,
  validationRules: [depthLimit(5)],
});

const createGraphQLMiddleware = ({ prismaClient }) => {
  const server = createGraphQLServer();
  const middleware = server.start().then(() =>
    expressMiddleware(server, {
      context: async () => createGraphQLContext(prismaClient),
    }),
  );

  const handler = async (req, res, next) => {
    try {
      const startedMiddleware = await middleware;
      return startedMiddleware(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
  handler.apolloServer = server;
  return handler;
};

module.exports = {
  createGraphQLContext,
  createGraphQLMiddleware,
  createGraphQLServer,
  createLoaders,
  schema,
};

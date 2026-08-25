'use strict';

const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@as-integrations/express4');
const { typeDefs } = require('./schema');
const { resolvers } = require('./resolvers');
const { prisma } = require('../../prismaClient');

const createGraphQLServer = () => new ApolloServer({ typeDefs, resolvers });

const buildContext = async ({ req }) => {
  const username = req.headers['x-user-username'];
  const address = req.headers['x-user-address'];
  let user = null;
  if (typeof username === 'string' && username.trim()) {
    user = await prisma.user.findFirst({
      where: {
        username: username.trim().toLowerCase(),
        ...(typeof address === 'string' && address.trim() ? { address: address.trim() } : {}),
        deletedAt: null,
      },
    });
  }
  return {
    req,
    user,
    authorization: req.headers.authorization || null,
    apiKey: req.headers['x-api-key'] || null,
  };
};

const attachGraphQL = (app) => {
  const server = createGraphQLServer();
  const middleware = server.start().then(() => expressMiddleware(server, { context: buildContext }));
  app.use('/graphql', async (req, res, next) => {
    try {
      return (await middleware)(req, res, next);
    } catch (error) {
      return next(error);
    }
  });
  return { server, ready: middleware };
};

module.exports = { attachGraphQL, buildContext, createGraphQLServer };

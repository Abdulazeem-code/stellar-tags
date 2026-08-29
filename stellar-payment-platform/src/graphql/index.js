const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@as-integrations/express4');
const { typeDefs } = require('./schema');
const { resolvers } = require('./resolvers');
const { prisma } = require('../../prismaClient');

const apolloServer = new ApolloServer({ typeDefs, resolvers });
const started = apolloServer.start();

const getContext = async ({ req }) => {
  const address = typeof req.headers['x-user-address'] === 'string'
    ? req.headers['x-user-address'].trim()
    : null;
  const username = typeof req.headers['x-username'] === 'string'
    ? req.headers['x-username'].trim().toLowerCase()
    : null;
  const apiKey = req.headers['x-api-key'];
  const user = address || username
    ? await prisma.user.findFirst({
      where: { ...(address ? { address } : { username }), deletedAt: null },
    })
    : null;

  return {
    req,
    auth: {
      address,
      username,
      authorization: req.headers.authorization || null,
      role: apiKey && apiKey === process.env.ADMIN_API_KEY ? 'admin' : 'user',
    },
    user,
  };
};

const graphqlMiddleware = (req, res, next) => {
  started
    .then(() => expressMiddleware(apolloServer, { context: getContext })(req, res, next))
    .catch(next);
};

module.exports = { graphqlMiddleware, apolloServer };

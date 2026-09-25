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

const createGraphQLServer = () => new ApolloServer({ schema });

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

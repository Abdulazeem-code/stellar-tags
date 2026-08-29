const { GraphQLScalarType, Kind } = require('graphql');

const typeDefs = `#graphql
  scalar DateTime

  type User {
    username: String!
    address: String!
    memoType: String
    memo: String
    createdAt: DateTime!
    flaggedAt: DateTime
    webhooks: [Webhook!]!
  }

  type Webhook {
    id: ID!
    username: String!
    url: String!
    createdAt: DateTime!
    lastSentAt: DateTime
    failingSince: DateTime
  }

  type UserConnection {
    nodes: [User!]!
    totalCount: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
  }

  input RegisterUserInput {
    username: String!
    address: String!
    memoType: String
    memo: String
    signature: String
    signerAddress: String
  }

  input CreateWebhookInput {
    username: String!
    url: String!
  }

  type MutationResult {
    success: Boolean!
    username: String
  }

  type Query {
    user(username: String, address: String): User
    users(search: String, page: Int = 1, limit: Int = 25): UserConnection!
    webhooks(username: String): [Webhook!]!
  }

  type Mutation {
    registerUser(input: RegisterUserInput!): User!
    deleteUser(username: String!): MutationResult!
    createWebhook(input: CreateWebhookInput!): Webhook!
    deleteWebhook(id: ID!): MutationResult!
  }
`;

const dateTime = new GraphQLScalarType({
  name: 'DateTime',
  serialize(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('Invalid DateTime value');
    return date.toISOString();
  },
  parseValue(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('Invalid DateTime value');
    return date;
  },
  parseLiteral(node) {
    if (node.kind !== Kind.STRING) throw new TypeError('DateTime must be a string');
    const date = new Date(node.value);
    if (Number.isNaN(date.getTime())) throw new TypeError('Invalid DateTime value');
    return date;
  },
});

module.exports = { typeDefs, dateTime };

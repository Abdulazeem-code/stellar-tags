'use strict';

const typeDefs = `
  scalar DateTime

  type User {
    username: ID!
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

  type Query {
    user(username: ID!): User
    users(search: String, limit: Int = 50, offset: Int = 0): [User!]!
    webhooks(username: ID): [Webhook!]!
  }

  input RegisterUserInput {
    username: ID!
    address: String!
    memoType: String
    memo: String
  }

  type Mutation {
    registerUser(input: RegisterUserInput!): User!
    deleteUser(username: ID!): Boolean!
    createWebhook(username: ID!, url: String!): Webhook!
    deleteWebhook(id: ID!): Boolean!
  }
`;

module.exports = { typeDefs };

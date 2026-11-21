'use strict';

/**
 * GraphQL type definitions.
 *
 * The object types mirror the Prisma models (`User`, `Webhook`) and their
 * relation: a `User` exposes its registered `webhooks`, and a `Webhook`
 * exposes its owning `user`. Field names follow GraphQL conventions
 * (camelCase) and map to the Prisma fields:
 *
 *   User.username, address, memoType, memo, createdAt, flaggedAt, deletedAt
 *   Webhook.id, username, url, secret, createdAt, lastSentAt, failingSince
 *
 * `createdAt`/`flaggedAt`/`deletedAt`/`lastSentAt`/`failingSince` are serialized
 * as ISO-8601 strings to stay transport-neutral.
 *
 * The `Query` and `Mutation` roots expose read and write operations for both
 * core entities, paralleling the REST endpoints:
 *
 *   Query
 *     user(username)            — by primary key
 *     userByAddress(address)    — by Stellar address
 *     users(search, page, limit) — paginated search (mirrors GET /users)
 *     federation(q, type)        — Stellar federation resolution (GET /federation)
 *     stats                     — platform counters (GET /stats)
 *     webhooks(...)             — list a user's webhooks (signature auth)
 *
 *   Mutation
 *     registerUser(input)       — register a federation name (POST /register)
 *     unregisterUser(username)  — soft-delete a name (DELETE /register/:username)
 *     blockUser(address)        — admin: flag an address (POST /admin/block)
 *     createWebhook(input)      — register a webhook (POST /webhooks)
 *     deleteWebhook(...)        — remove a webhook (DELETE /webhooks/:id)
 */
const typeDefs = /* GraphQL */ `
  type User {
    username: String!
    address: String!
    memoType: String
    memo: String
    createdAt: String!
    flaggedAt: String
    deletedAt: String
    federationAddress: String!
    isFlagged: Boolean!
    isDeleted: Boolean!
    webhooks: [Webhook!]!
  }

  type Webhook {
    id: ID!
    username: String!
    url: String!
    secret: String
    createdAt: String!
    lastSentAt: String
    failingSince: String
    user: User
  }

  type Stats {
    totalRegisteredUsers: Int!
    activeTokens: Int!
    platformUptimeSeconds: Int!
    platformUptimeStartedAt: String!
  }

  type UserPage {
    data: [User!]!
    totalCount: Int!
    totalPages: Int!
    currentPage: Int!
    limit: Int!
  }

  type FederationResult {
    stellarAddress: String!
    accountId: String!
    memoType: String
    memo: String
  }

  type Verification {
    accountId: String
    signerCount: Int
    thresholdMet: Boolean!
    requiredThreshold: Int
    providedWeight: Int
  }

  type RegisterResult {
    ok: Boolean!
    user: User!
    verification: Verification
  }

  type CreateWebhookResult {
    ok: Boolean!
    webhook: Webhook!
    note: String
  }

  type DeleteResult {
    ok: Boolean!
    deleted: Boolean!
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
    signature: String
    signerAddress: String
    operation: String
  }

  type Query {
    user(username: String!): User
    userByAddress(address: String!): User
    users(search: String, page: Int = 1, limit: Int = 10): UserPage!
    federation(q: String!, type: String = "name"): FederationResult
    stats: Stats!
    webhooks(
      username: String!
      signature: String
      signerAddress: String
      operation: String
    ): [Webhook!]!
  }

  type Mutation {
    registerUser(input: RegisterUserInput!): RegisterResult!
    unregisterUser(username: String!): DeleteResult!
    blockUser(address: String!): User!
    createWebhook(input: CreateWebhookInput!): CreateWebhookResult!
    deleteWebhook(
      id: ID!
      username: String!
      signature: String
      signerAddress: String
      operation: String
    ): DeleteResult!
  }
`;

module.exports = { typeDefs };

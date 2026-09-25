'use strict';

/**
 * #685 — GraphQL type definitions.
 *
 * The SDL is the single source of truth for the API surface; `makeSchema`
 * compiles it and grafts the resolvers from `src/graphql/resolvers` onto the
 * resulting types, so there is no second place to keep in sync.
 *
 * Field names follow the GraphQL convention (camelCase) rather than the REST
 * layer's snake_case. Timestamps are ISO-8601 strings, which is exactly what
 * the REST endpoints already emit, so a client can move between the two
 * without a translation layer.
 *
 * Notes on security posture:
 *   - `Webhook.secret` and `ApiKey.keyHash` are deliberately absent. They are
 *     write-only credentials and must never appear in a response body.
 *   - Every field that exposes per-account data (`User.activity`,
 *     `Query.webhooks`, ...) is gated by ownership proof in the resolver.
 */

const typeDefs = `#graphql
"""
An ISO-8601 timestamp, e.g. \`2026-01-31T09:15:00.000Z\`.
"""
scalar DateTime

"""
A JSON value, returned exactly as stored. Used for the free-form
\`metadata\` columns on payment intents and activity rows.
"""
scalar JSON

enum OrderDirection {
  ASC
  DESC
}

enum UserOrderField {
  CREATED_AT
  USERNAME
}

enum FederationQueryType {
  "Resolve a name tag (\\"alice*example.com\\") to an address."
  NAME
  "Resolve a Stellar address back to its primary name tag."
  ID
}

enum StatsInterval {
  DAY
  WEEK
  MONTH
}

input UserOrder {
  field: UserOrderField! = CREATED_AT
  direction: OrderDirection! = DESC
}

input PaymentOrder {
  "Defaults to CREATED_AT."
  field: String = "CREATED_AT"
  direction: OrderDirection! = DESC
}

input PaginationArgs {
  "1-based page number."
  page: Int = 1
  "Rows per page (capped at 100)."
  limit: Int = 10
}

input DateRange {
  "Inclusive lower bound."
  startDate: DateTime
  "Inclusive upper bound."
  endDate: DateTime
}

input UserFilter {
  "Case-insensitive substring match against username or address."
  search: String
  address: String
  isPrimary: Boolean
  """
  When true, only flagged (blocked) accounts are returned. When false, only
  unflagged ones. Omit for both.
  """
  flagged: Boolean
  "Soft-deleted accounts are hidden unless this is true."
  includeDeleted: Boolean = false
}

input PaymentFilter {
  fromAddress: String
  toAddress: String
  status: String
  assetCode: String
  minAmount: Float
  maxAmount: Float
  range: DateRange
}

input PaymentIntentFilter {
  from: String
  to: String
  status: String
  externalId: String
  range: DateRange
}

"""
A registered federation account (\`username_registry\`).
"""
type User {
  username: String!
  address: String!
  "True for the username that reverse (type=id) federation lookups resolve to."
  isPrimary: Boolean!
  memoType: String
  memo: String
  createdAt: DateTime!
  "Set when an administrator blocks the account."
  flaggedAt: DateTime
  "Set by the soft-delete endpoint; the row is retained for auditing."
  deletedAt: DateTime
  "The \\"name*domain\\" form a wallet uses to pay this account."
  federationAddress: String!

  """
  Webhook endpoints owned by this account. Batched — one query for the whole
  page of users, not one per user.
  """
  webhooks: [Webhook!]!
  "Total webhooks owned. Batched via a single GROUP BY."
  webhookCount: Int!
  "Most recent activity rows for this account, newest first."
  activity(limit: Int = 20): [ActivityLog!]!
  "Total activity rows for this account."
  activityCount: Int!
  "Sent/received totals for this account's address. Batched via GROUP BY."
  paymentStats: AddressPaymentStats
}

"""
A webhook registration. The signing secret is intentionally not exposed.
"""
type Webhook {
  id: ID!
  username: String!
  url: String!
  "The event types this webhook subscribes to, as stored. A single star means every event."
  events: [String!]!
  createdAt: DateTime!
  lastSentAt: DateTime
  "Set when deliveries started failing; cleared once one succeeds."
  failingSince: DateTime
  "True while the endpoint is in a failing state."
  isFailing: Boolean!
}

"""
A routed payment.
"""
type Payment {
  id: ID!
  createdAt: DateTime!
  fromAddress: String!
  toAddress: String!
  amount: Float!
  fee: Float!
  assetCode: String
  transactionHash: String
  status: String!
  "Registered account behind \`fromAddress\`, when there is one."
  fromUser: User
  "Registered account behind \`toAddress\`, when there is one."
  toUser: User
}

"""
A requested payment awaiting routing.
"""
type PaymentIntent {
  id: ID!
  externalId: String
  from: String!
  to: String!
  amount: String!
  asset: String
  memoType: String
  memo: String
  metadata: JSON
  status: String!
  createdAt: DateTime!
  fromUser: User
  toUser: User
}

"""
One row of an account's self-service activity trail.
"""
type ActivityLog {
  id: ID!
  username: String!
  action: String!
  metadata: JSON
  ipAddress: String
  createdAt: DateTime!
}

"""
Sent and received totals for a single address.
"""
type AddressPaymentStats {
  address: String!
  sentCount: Int!
  sentAmount: Float!
  sentFees: Float!
  receivedCount: Int!
  receivedAmount: Float!
  receivedFees: Float!
  totalCount: Int!
  totalAmount: Float!
  totalFees: Float!
}

type UserConnection {
  nodes: [User!]!
  totalCount: Int!
  currentPage: Int!
  totalPages: Int!
  hasNextPage: Boolean!
}

type PaymentConnection {
  nodes: [Payment!]!
  totalCount: Int!
  currentPage: Int!
  totalPages: Int!
  hasNextPage: Boolean!
}

type PaymentIntentConnection {
  nodes: [PaymentIntent!]!
  totalCount: Int!
  currentPage: Int!
  totalPages: Int!
  hasNextPage: Boolean!
}

type ActivityConnection {
  nodes: [ActivityLog!]!
  totalCount: Int!
  currentPage: Int!
  totalPages: Int!
  hasNextPage: Boolean!
}

"""
Platform-wide counters, served from the same cache as \`GET /stats\`.
"""
type PlatformStats {
  totalRegisteredUsers: Int!
  activeTokens: Int!
  platformUptimeSeconds: Int!
  platformUptimeStartedAt: DateTime!
}

type StatsBucket {
  "Bucket key: YYYY-MM-DD (day), the Monday of the week, or YYYY-MM."
  period: String!
  volume: Float!
  fees: Float!
  count: Int!
}

type RoutingStats {
  interval: StatsInterval!
  startDate: DateTime
  endDate: DateTime
  totalVolume: Float!
  totalFees: Float!
  totalCount: Int!
  data: [StatsBucket!]!
}

"""
A federation resolution, matching the \`GET /federation\` payload.
"""
type FederationRecord {
  stellarAddress: String!
  accountId: String!
  memoType: String
  memo: String
}

type Health {
  status: String!
  uptimeSeconds: Int!
  startedAt: DateTime!
  database: String!
  redis: String!
}

type Query {
  "Look up one account by name tag."
  user(username: String!): User
  "Look up the primary account for a Stellar address."
  userByAddress(address: String!): User
  "List accounts. The dashboard's main read path."
  users(filter: UserFilter, orderBy: [UserOrder!], pagination: PaginationArgs): UserConnection!

  """
  The caller's webhook registrations. Requires ownership proof: a Bearer token,
  or the X-Stellar-Signature headers naming the account.

  Nullable deliberately. Without proof this resolves to null and the reason is
  in the errors array, so a client that asked for this alongside other fields
  keeps them. Declaring it non-null would propagate the failure to the root and
  null the whole response.
  """
  webhooks: [Webhook!]
  "One webhook by id. Rejected unless the caller owns it."
  webhook(id: ID!): Webhook

  payments(filter: PaymentFilter, orderBy: PaymentOrder, pagination: PaginationArgs): PaymentConnection!
  payment(id: ID!): Payment

  paymentIntent(id: ID!): PaymentIntent
  paymentIntents(filter: PaymentIntentFilter, pagination: PaginationArgs): PaymentIntentConnection!

  """
  An account's activity trail. Requires ownership proof for the username.

  Nullable for the same reason as webhooks: a rejected proof should cost this
  field, not the rest of the response.
  """
  activity(username: String!, range: DateRange, pagination: PaginationArgs): ActivityConnection

  """
  Federation name/address resolution, served from the same cache as the REST
  endpoint.
  """
  federation(q: String!, type: FederationQueryType = NAME): FederationRecord

  platformStats: PlatformStats!
  "Payment volume aggregated by day, week, or month."
  routingStats(range: DateRange, groupBy: StatsInterval = DAY, assetCode: String): RoutingStats!
  health: Health!
}
`;

module.exports = { typeDefs };

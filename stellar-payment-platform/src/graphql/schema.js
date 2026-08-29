'use strict';

const typeDefs = `
  scalar DateTime

  # ──────────────────────────────────────────────────────────────────────────
  # Core types
  # ──────────────────────────────────────────────────────────────────────────

  """A registered user / Stellar tag."""
  type User {
    username: ID!
    address: String!
    memoType: String
    memo: String
    createdAt: DateTime!
    flaggedAt: DateTime
    deletedAt: DateTime
    webhooks: [Webhook!]!
  }

  """A webhook endpoint registered by a user."""
  type Webhook {
    id: ID!
    username: String!
    url: String!
    createdAt: DateTime!
    lastSentAt: DateTime
    failingSince: DateTime
  }

  """Federation lookup response — mirrors the /federation REST response."""
  type FederationResult {
    stellarAddress: String!
    accountId: String!
    memoType: String
    memo: String
  }

  """Lookup response for an address-to-username query."""
  type LookupResult {
    username: String!
    address: String!
  }

  """Paginated list of users."""
  type UserPage {
    data: [User!]!
    totalCount: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
  }

  """Platform-level statistics."""
  type Stats {
    totalRegisteredUsers: Int!
    activeTokens: Int!
    platformUptimeSeconds: Int!
    platformUptimeStartedAt: DateTime!
  }

  # ──────────────────────────────────────────────────────────────────────────
  # Queries
  # ──────────────────────────────────────────────────────────────────────────

  type Query {
    """Look up a single user by username. Returns null if not found."""
    user(username: ID!): User

    """Paginated, optionally filtered list of registered users."""
    users(
      search: String
      limit: Int = 50
      offset: Int = 0
    ): [User!]!

    """Paginated list of users with full page metadata."""
    usersPage(
      search: String
      page: Int = 1
      limit: Int = 10
    ): UserPage!

    """List webhooks. Without a username arg only admins may list all."""
    webhooks(username: ID): [Webhook!]!

    """Resolve a Stellar address to its registered username tag."""
    lookupByAddress(address: String!): LookupResult

    """
    Federation lookup — resolve a name tag (e.g. alice*localhost) or a
    Stellar address to its full federation entry.
    """
    resolveTag(
      """
      The tag to resolve, e.g. alice*localhost. May omit the domain part
      (alice) when querying by name; the server will normalise it.
      """
      q: String!
      """
      'name' (default) resolves a username tag to an address.
      'id' resolves a Stellar address back to a tag.
      """
      type: TagLookupType
    ): FederationResult

    """Platform statistics."""
    stats: Stats!
  }

  """Federation query type."""
  enum TagLookupType {
    name
    id
  }

  # ──────────────────────────────────────────────────────────────────────────
  # Mutations
  # ──────────────────────────────────────────────────────────────────────────

  input RegisterUserInput {
    username: ID!
    address: String!
    memoType: String
    memo: String
  }

  input UpdateUserInput {
    """New memo type (or null to clear)."""
    memoType: String
    """New memo value (or null to clear)."""
    memo: String
  }

  type Mutation {
    """Register a new username ↔ address mapping."""
    registerUser(input: RegisterUserInput!): User!

    """
    Soft-delete a user. Requires the caller to be the owner of the account
    (enforced via the auth context).
    """
    deleteUser(username: ID!): Boolean!

    """Update memo fields for an existing user. Owner-only."""
    updateUser(username: ID!, input: UpdateUserInput!): User!

    """
    Flag/block a Stellar address. Admin-only (requires x-api-key header
    matching ADMIN_API_KEY).
    """
    flagUser(username: ID!): User!

    """Register a webhook URL for a username. Owner-only."""
    createWebhook(username: ID!, url: String!): Webhook!

    """Delete a webhook by id. Owner-only."""
    deleteWebhook(id: ID!): Boolean!
  }
`;

module.exports = { typeDefs };

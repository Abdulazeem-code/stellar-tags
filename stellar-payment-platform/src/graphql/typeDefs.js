'use strict';

/**
 * GraphQL schema for the Stellar Payment Platform.
 *
 * Types mirror the Prisma schema (User, Webhook) and expose the same
 * operations the REST API provides, so the frontend can choose whichever
 * transport prevents over- or under-fetching for a given view.
 */

// Apollo Server 4 accepts a plain string for typeDefs — no graphql-tag needed.
const typeDefs = `
  """
  A registered Stellar user / federation tag.
  Maps to the \`username_registry\` table.
  """
  type User {
    username: String!
    address: String!
    memoType: String
    memo: String
    createdAt: String
    flaggedAt: String
    deletedAt: String
    webhooks: [Webhook!]!
  }

  """
  A webhook subscription owned by a User.
  The \`secret\` field is intentionally omitted — it is only returned once,
  at creation time, from the \`createWebhook\` mutation.
  """
  type Webhook {
    id: ID!
    username: String!
    url: String!
    createdAt: String
    lastSentAt: String
    failingSince: String
  }

  """
  Pagination metadata returned alongside paginated lists.
  """
  type PageInfo {
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
  }

  """
  A page of User results.
  """
  type UserPage {
    data: [User!]!
    pageInfo: PageInfo!
  }

  """
  Federation lookup result — mirrors the REST /federation response shape.
  """
  type FederationRecord {
    stellar_address: String!
    account_id: String!
    memo_type: String
    memo: String
  }

  """
  Result returned after successfully registering a new username.
  """
  type RegisterResult {
    ok: Boolean!
    username: String!
    address: String!
    federation_address: String!
    memo_type: String
    memo: String
  }

  """
  Result returned after soft-deleting (unregistering) a username.
  """
  type UnregisterResult {
    ok: Boolean!
    username: String!
    deleted: Boolean!
  }

  """
  A newly-created webhook.  The HMAC \`secret\` is only present on creation.
  """
  type WebhookCreated {
    ok: Boolean!
    id: ID!
    username: String!
    url: String!
    secret: String!
    createdAt: String!
    note: String!
  }

  """
  Result returned after deleting a webhook.
  """
  type WebhookDeleteResult {
    ok: Boolean!
    deleted: Boolean!
  }

  # ---------------------------------------------------------------------------
  # Queries
  # ---------------------------------------------------------------------------

  type Query {
    """
    Fetch a single user by username (tag, e.g. \`alice*localhost\`).
    Returns null when the user does not exist or has been soft-deleted.
    """
    user(username: String!): User

    """
    Look up a user by their Stellar address.
    Returns null when no user is registered with that address.
    """
    userByAddress(address: String!): User

    """
    Paginated list of active (non-deleted) users.
    Optional \`search\` matches against username and address (case-insensitive).
    """
    users(search: String, page: Int, limit: Int): UserPage!

    """
    Federation lookup — resolve a tag (\`alice*domain\`) or Stellar address
    to its full federation record.  Mirrors \`GET /federation\`.
    Pass \`type: "id"\` to look up by Stellar address, or \`type: "name"\`
    (default) to look up by username tag.
    """
    federation(q: String!, type: String): FederationRecord

    """
    List webhooks registered for a given username.
    Requires the caller to be authenticated as that user (checked via
    \`context.verifiedAddress\`).
    """
    webhooks(username: String!): [Webhook!]!
  }

  # ---------------------------------------------------------------------------
  # Mutations
  # ---------------------------------------------------------------------------

  type Mutation {
    """
    Register a new username tag linked to a Stellar address.
    Optionally supply a \`memoType\`/\`memo\` pair (text | id | hash).
    """
    register(
      username: String!
      address: String!
      memoType: String
      memo: String
    ): RegisterResult!

    """
    Soft-delete (unregister) a username.
    Sets \`deletedAt\` to the current timestamp; the row is retained for audit.
    """
    unregister(username: String!): UnregisterResult!

    """
    Register a new webhook URL for the authenticated user.
    Returns the HMAC signing secret — save it; it will not be shown again.
    """
    createWebhook(username: String!, url: String!): WebhookCreated!

    """
    Delete a webhook by its ID.  Only the owning user may delete their webhook.
    """
    deleteWebhook(id: ID!, username: String!): WebhookDeleteResult!
  }
`;

module.exports = { typeDefs };

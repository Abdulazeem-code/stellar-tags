'use strict';

/**
 * GraphQL schema definition language (SDL).
 *
 * Types mirror the Prisma schema (User + Webhook) and expose the same data
 * shapes as the existing REST endpoints, so the frontend can switch between
 * transports without needing to understand a different model.
 *
 * Nullable fields mirror the optional columns in schema.prisma.
 * The `deleted_at` / `flagged_at` columns are intentionally excluded from the
 * public-facing API — they are internal implementation details.
 */
const typeDefs = `#graphql

  # ─── Scalars ──────────────────────────────────────────────────────────────

  """
  ISO-8601 date-time string (UTC). Returned by all timestamp fields.
  """
  scalar DateTime

  # ─── Types ────────────────────────────────────────────────────────────────

  """
  A registered Stellar username → address mapping.
  """
  type User {
    """
    The normalised, lower-case username (e.g. 'alice' or 'alice*localhost').
    """
    username: String!
    """
    The Stellar public key (G…) associated with this username.
    """
    address: String!
    """
    Stellar federation address in 'username*domain' form.
    """
    federation_address: String!
    """
    Optional SEP-0006 memo type ('text', 'id', or 'hash').
    """
    memo_type: String
    """
    Optional SEP-0006 memo value.
    """
    memo: String
    """
    UTC timestamp of when this registration was created.
    """
    created_at: DateTime!
    """
    Webhooks registered under this username (only accessible when the request
    is authenticated as this user).
    """
    webhooks: [Webhook!]
  }

  """
  A webhook endpoint that receives POST notifications for incoming payments.
  """
  type Webhook {
    id: String!
    username: String!
    url: String!
    """
    UTC timestamp when the webhook was registered.
    """
    created_at: DateTime!
    """
    UTC timestamp of the most recent successful delivery, if any.
    """
    last_sent_at: DateTime
    """
    UTC timestamp since which consecutive deliveries have failed, if any.
    """
    failing_since: DateTime
  }

  """
  Paginated list of users with cursor-style metadata.
  """
  type UserPage {
    data: [User!]!
    meta: PageMeta!
  }

  """
  Standard pagination metadata returned on any paged collection.
  """
  type PageMeta {
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
  }

  """
  Result of a federation lookup (address ↔ username resolution).
  """
  type FederationResult {
    stellar_address: String!
    account_id: String!
    memo_type: String
    memo: String
  }

  """
  Returned after a successful registration.
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
  Returned after a successful soft-delete (unregister).
  """
  type DeleteResult {
    ok: Boolean!
    username: String!
    deleted: Boolean!
  }

  """
  Returned after registering a new webhook.
  The secret is only returned here — store it securely.
  """
  type WebhookCreateResult {
    ok: Boolean!
    webhook: Webhook!
    """
    HMAC-SHA256 signing secret. Only returned once — save it immediately.
    """
    secret: String!
    note: String!
  }

  """
  Returned after deleting a webhook.
  """
  type WebhookDeleteResult {
    ok: Boolean!
    deleted: Boolean!
  }

  # ─── Inputs ───────────────────────────────────────────────────────────────

  """
  Input for the registerUser mutation.
  """
  input RegisterInput {
    username: String!
    address: String!
    memo_type: String
    memo: String
    signature: String
    signerAddress: String
  }

  """
  Input for the registerWebhook mutation.
  Requires username + signature authentication (same as the REST endpoint).
  """
  input WebhookInput {
    username: String!
    url: String!
    signature: String!
    signerAddress: String
    operation: String
  }

  """
  Input for the deleteWebhook mutation.
  """
  input DeleteWebhookInput {
    id: String!
    username: String!
    signature: String!
    signerAddress: String
    operation: String
  }

  # ─── Queries ──────────────────────────────────────────────────────────────

  type Query {
    """
    Resolve a username or Stellar address via the federation protocol.
    Equivalent to GET /federation.

    Pass type='name' (default) to resolve a username tag to an address.
    Pass type='id' to resolve a Stellar address to a username.
    """
    federation(q: String!, type: String): FederationResult

    """
    Resolve a Stellar address to its registered username.
    Equivalent to GET /lookup?address=…
    """
    lookupUser(address: String!): User

    """
    List registered users with optional search and pagination.
    Equivalent to GET /users or GET /lookup (without address).
    """
    listUsers(
      search: String
      page: Int
      limit: Int
    ): UserPage!

    """
    Return a single user record by username.
    """
    getUser(username: String!): User

    """
    Return the server's current UTC time. Useful for health checks.
    """
    serverTime: DateTime!
  }

  # ─── Mutations ────────────────────────────────────────────────────────────

  type Mutation {
    """
    Register a new Stellar username → address mapping.
    Equivalent to POST /register.
    """
    registerUser(input: RegisterInput!): RegisterResult!

    """
    Soft-delete a registered username (sets deleted_at).
    Equivalent to DELETE /register/:username.
    """
    deleteUser(username: String!): DeleteResult!

    """
    Register a webhook URL for payment notifications.
    Equivalent to POST /webhooks.
    """
    registerWebhook(input: WebhookInput!): WebhookCreateResult!

    """
    Delete a registered webhook.
    Equivalent to DELETE /webhooks/:id.
    """
    deleteWebhook(input: DeleteWebhookInput!): WebhookDeleteResult!
  }
`;

module.exports = { typeDefs };

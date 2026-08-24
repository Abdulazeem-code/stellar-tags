'use strict';

/**
 * GraphQL resolvers for the Stellar Payment Platform.
 *
 * All resolver logic delegates to the same Prisma client and utility
 * functions that the REST routes use, so there is a single source of truth
 * for every business rule.  Where the REST routes throw HTTP errors, these
 * resolvers throw GraphQLError with a matching extension code.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { GraphQLError } = require('graphql');
const { StrKey } = require('@stellar/stellar-sdk');
const xss = require('xss');

const { invalidateFederationCache, lookupCached, federationIdKey, federationNameKey } = require('../cache');
const { normalizeNameTag, validateMemo, RESERVED_NAMES, USER_DATABASE, shouldFallbackToLocalRegistry } = require('../utils');
const { requireAuthHeader } = require('./context');
const { poolGet, poolRun, poolAll } = require('../db');

// ---------------------------------------------------------------------------
// Error factory helpers
// ---------------------------------------------------------------------------

const gqlError = (message, code, httpStatus = 400) =>
  new GraphQLError(message, {
    extensions: { code, http: { status: httpStatus } },
  });

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

const clamp = (value, min, max, fallback) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

// ---------------------------------------------------------------------------
// User field resolvers
// ---------------------------------------------------------------------------

const UserResolver = {
  /** Lazy-load webhooks for a User only when the query requests them. */
  async webhooks(parent, _args, { prisma }) {
    try {
      return await prisma.webhook.findMany({
        where: { username: parent.username },
        orderBy: { createdAt: 'desc' },
      });
    } catch (err) {
      if (!shouldFallbackToLocalRegistry(err)) throw err;
      const rows = await poolAll(
        'SELECT id, username, url, created_at, last_sent_at, failing_since FROM webhooks WHERE username = ? ORDER BY created_at DESC',
        [parent.username],
      );
      return rows.map((r) => ({
        id: r.id,
        username: r.username,
        url: r.url,
        createdAt: r.created_at,
        lastSentAt: r.last_sent_at,
        failingSince: r.failing_since,
      }));
    }
  },
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const Query = {
  /**
   * Fetch a single User by username tag (e.g. "alice*localhost").
   * Non-deleted users only.
   */
  async user(_parent, { username }, { prisma, logger }) {
    const normalized = normalizeNameTag(xss(username)).toLowerCase();
    if (!normalized) throw gqlError('username is required', 'INVALID_INPUT');

    try {
      const row = await prisma.user.findFirst({
        where: { username: normalized, deletedAt: null },
      });
      if (!row) return null;
      return serializeUser(row);
    } catch (err) {
      logger.error(err, '[graphql] user query failed');
      if (shouldFallbackToLocalRegistry(err)) {
        const localRow = await poolGet(
          'SELECT username, address, created_at FROM username_registry WHERE username = ? LIMIT 1',
          [normalized],
        );
        return localRow
          ? { username: localRow.username, address: localRow.address, createdAt: localRow.created_at }
          : null;
      }
      throw gqlError('Database lookup failed', 'INTERNAL_ERROR', 500);
    }
  },

  /**
   * Fetch a single User by their Stellar address.
   * Non-deleted users only.
   */
  async userByAddress(_parent, { address }, { prisma, logger }) {
    if (!address || !StrKey.isValidEd25519PublicKey(address)) {
      throw gqlError('Invalid Stellar address format', 'INVALID_INPUT');
    }

    try {
      const row = await prisma.user.findFirst({
        where: { address, deletedAt: null },
      });
      if (!row) return null;
      return serializeUser(row);
    } catch (err) {
      logger.error(err, '[graphql] userByAddress query failed');
      if (shouldFallbackToLocalRegistry(err)) {
        const localRow = await poolGet(
          'SELECT username, address, created_at FROM username_registry WHERE address = ? LIMIT 1',
          [address],
        );
        return localRow
          ? { username: localRow.username, address: localRow.address, createdAt: localRow.created_at }
          : null;
      }
      throw gqlError('Database lookup failed', 'INTERNAL_ERROR', 500);
    }
  },

  /**
   * Paginated list of active users, optionally filtered by a search string.
   */
  async users(_parent, { search, page: rawPage, limit: rawLimit }, { prisma, logger }) {
    const page = clamp(rawPage, 1, Number.MAX_SAFE_INTEGER, 1);
    const limit = clamp(rawLimit, 1, 100, 10);
    const skip = (page - 1) * limit;

    const where = search
      ? {
          deletedAt: null,
          OR: [
            { username: { contains: search, mode: 'insensitive' } },
            { address: { contains: search, mode: 'insensitive' } },
          ],
        }
      : { deletedAt: null };

    try {
      const [totalCount, rows] = await prisma.$transaction([
        prisma.user.count({ where }),
        prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      ]);
      return {
        data: rows.map(serializeUser),
        pageInfo: {
          total: totalCount,
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit),
        },
      };
    } catch (err) {
      logger.error(err, '[graphql] users query failed');
      throw gqlError('Database error', 'INTERNAL_ERROR', 500);
    }
  },

  /**
   * Federation lookup — resolves a tag or Stellar address to a federation record.
   * Mirrors GET /federation.
   */
  async federation(_parent, { q, type }, { prisma, logger }) {
    if (!q) throw gqlError("Missing 'q' parameter", 'INVALID_INPUT');

    const queryType = type === 'id' ? 'id' : 'name';

    try {
      if (queryType === 'id') {
        // address → username lookup
        if (!StrKey.isValidEd25519PublicKey(q)) {
          throw gqlError('Invalid Stellar address format', 'INVALID_INPUT');
        }

        const result = await lookupCached(federationIdKey(q), async () => {
          const row = await prisma.user.findFirst({
            where: { address: q, deletedAt: null },
          });
          return row
            ? {
                stellar_address: `${row.username}*${process.env.DOMAIN || 'localhost'}`,
                account_id: row.address,
                memo_type: row.memoType || null,
                memo: row.memo || null,
              }
            : null;
        });

        if (!result) throw gqlError('Name tag not found', 'NOT_FOUND', 404);
        return result;
      }

      // name → address lookup
      const normalizedTag = normalizeNameTag(q).toLowerCase();
      if (!normalizedTag) throw gqlError("Missing 'q' parameter", 'INVALID_INPUT');

      const result = await lookupCached(federationNameKey(normalizedTag), async () => {
        // Check in-memory fallback first
        const fallbackAddress = USER_DATABASE[normalizedTag];
        if (fallbackAddress) {
          return {
            stellar_address: normalizedTag,
            account_id: fallbackAddress,
            memo_type: null,
            memo: null,
          };
        }

        const row = await prisma.user.findFirst({
          where: { username: normalizedTag, deletedAt: null },
        });
        return row
          ? {
              stellar_address: normalizedTag,
              account_id: row.address,
              memo_type: row.memoType || null,
              memo: row.memo || null,
            }
          : null;
      });

      if (!result) throw gqlError('Name tag not found', 'NOT_FOUND', 404);
      return result;
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      logger.error(err, '[graphql] federation query failed');
      throw gqlError('Database lookup failed', 'INTERNAL_ERROR', 500);
    }
  },

  /**
   * List webhooks for a username.  Requires an authenticated caller.
   */
  async webhooks(_parent, { username }, context) {
    requireAuthHeader(context);
    const { prisma, stellarAddress, logger } = context;

    const normalized = normalizeNameTag(xss(username)).toLowerCase();

    // Verify the authenticated address owns this username
    try {
      const user = await prisma.user.findFirst({
        where: { username: normalized, deletedAt: null },
        select: { address: true },
      });
      if (!user) throw gqlError('Username not found', 'NOT_FOUND', 404);
      if (user.address !== stellarAddress) {
        throw gqlError('Forbidden: address does not match username owner', 'FORBIDDEN', 403);
      }
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      logger.error(err, '[graphql] webhooks ownership check failed');
      throw gqlError('Database error', 'INTERNAL_ERROR', 500);
    }

    try {
      const rows = await prisma.webhook.findMany({
        where: { username: normalized },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(serializeWebhook);
    } catch (err) {
      if (!shouldFallbackToLocalRegistry(err)) {
        logger.error(err, '[graphql] webhooks query failed');
        throw gqlError('Database error', 'INTERNAL_ERROR', 500);
      }
      const rows = await poolAll(
        'SELECT id, username, url, created_at, last_sent_at, failing_since FROM webhooks WHERE username = ? ORDER BY created_at DESC',
        [normalized],
      );
      return rows.map((r) => ({
        id: r.id,
        username: r.username,
        url: r.url,
        createdAt: r.created_at,
        lastSentAt: r.last_sent_at,
        failingSince: r.failing_since,
      }));
    }
  },
};

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const Mutation = {
  /**
   * Register a new username linked to a Stellar address.
   */
  async register(_parent, { username, address, memoType, memo }, { prisma, logger }) {
    const safeUsername = xss(username);
    const normalizedUsername = normalizeNameTag(safeUsername).toLowerCase();

    // Validate address
    if (address.toUpperCase().startsWith('S')) {
      throw gqlError(
        'Never share your Secret Key. Please register using your Public Key (starts with G).',
        'INVALID_INPUT',
      );
    }
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw gqlError('Invalid Stellar Public Key format.', 'INVALID_INPUT');
    }

    // Validate memo pair
    const memoError = validateMemo(memoType, memo);
    if (memoError) throw gqlError(memoError, 'INVALID_INPUT');

    // Validate username constraints
    const bareUsername = normalizedUsername.split('*')[0];
    if (!/^[a-zA-Z0-9]{3,20}$/.test(bareUsername)) {
      throw gqlError('username must be 3-20 alphanumeric characters', 'INVALID_INPUT');
    }
    if (RESERVED_NAMES.includes(bareUsername)) {
      throw gqlError('This username is reserved and cannot be registered.', 'FORBIDDEN', 403);
    }

    try {
      const existingByAddress = await prisma.user.findFirst({
        where: { address, deletedAt: null },
      });
      if (existingByAddress) throw gqlError('Address already registered', 'CONFLICT', 409);

      await prisma.user.create({
        data: {
          username: normalizedUsername,
          address,
          ...(memoType && { memoType, memo }),
        },
      });

      invalidateFederationCache(normalizedUsername, address);

      return {
        ok: true,
        username: normalizedUsername,
        address,
        federation_address: `${normalizedUsername}*${process.env.DOMAIN || 'localhost'}`,
        memo_type: memoType || null,
        memo: memo || null,
      };
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      if (err.code === 'P2002') throw gqlError('Username is already taken.', 'CONFLICT', 409);
      logger.error(err, '[graphql] register mutation failed');
      throw gqlError('Registration failed', 'INTERNAL_ERROR', 500);
    }
  },

  /**
   * Soft-delete (unregister) a username.
   */
  async unregister(_parent, { username }, { prisma, logger }) {
    const normalized = normalizeNameTag(xss(username)).toLowerCase();
    if (!normalized) throw gqlError('username is required', 'INVALID_INPUT');

    try {
      const existing = await prisma.user.findFirst({
        where: { username: normalized, deletedAt: null },
      });
      if (!existing) throw gqlError('Username not found or already deleted', 'NOT_FOUND', 404);

      await prisma.user.update({
        where: { username: normalized },
        data: { deletedAt: new Date() },
      });

      invalidateFederationCache(normalized, existing.address);

      return { ok: true, username: normalized, deleted: true };
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      logger.error(err, '[graphql] unregister mutation failed');
      throw gqlError('Failed to unregister account', 'INTERNAL_ERROR', 500);
    }
  },

  /**
   * Register a new webhook URL for the authenticated user.
   */
  async createWebhook(_parent, { username, url }, context) {
    requireAuthHeader(context);
    const { prisma, stellarAddress, logger } = context;

    const normalized = normalizeNameTag(xss(username)).toLowerCase();

    // Validate URL
    if (!isValidWebhookUrl(url)) {
      throw gqlError('Invalid webhook URL. Must be http or https.', 'INVALID_INPUT');
    }

    // Verify ownership
    try {
      const user = await prisma.user.findFirst({
        where: { username: normalized, deletedAt: null },
        select: { address: true },
      });
      if (!user) throw gqlError('Username not found', 'NOT_FOUND', 404);
      if (user.address !== stellarAddress) {
        throw gqlError('Forbidden: address does not match username owner', 'FORBIDDEN', 403);
      }
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      throw gqlError('Database error', 'INTERNAL_ERROR', 500);
    }

    const secret = crypto.randomBytes(32).toString('hex');
    const id = uuidv4();
    const now = new Date();

    try {
      const webhook = await prisma.webhook.create({
        data: { id, username: normalized, url, secret, createdAt: now },
      });

      return {
        ok: true,
        id: webhook.id,
        username: webhook.username,
        url: webhook.url,
        secret,
        createdAt: (webhook.createdAt instanceof Date ? webhook.createdAt : new Date(webhook.createdAt)).toISOString(),
        note: 'Save the secret securely — it will only be returned once. Signatures for webhook payloads are computed with HMAC-SHA256 using this secret.',
      };
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      if (err.code === 'P2002') {
        throw gqlError('A webhook with this URL is already registered for the user.', 'CONFLICT', 409);
      }
      logger.error(err, '[graphql] createWebhook mutation failed');
      throw gqlError('Failed to register webhook', 'INTERNAL_ERROR', 500);
    }
  },

  /**
   * Delete a webhook by ID.  Only the owning user may delete their webhook.
   */
  async deleteWebhook(_parent, { id, username }, context) {
    requireAuthHeader(context);
    const { prisma, stellarAddress, logger } = context;

    const normalized = normalizeNameTag(xss(username)).toLowerCase();

    // Verify ownership
    try {
      const user = await prisma.user.findFirst({
        where: { username: normalized, deletedAt: null },
        select: { address: true },
      });
      if (!user) throw gqlError('Username not found', 'NOT_FOUND', 404);
      if (user.address !== stellarAddress) {
        throw gqlError('Forbidden: address does not match username owner', 'FORBIDDEN', 403);
      }
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      throw gqlError('Database error', 'INTERNAL_ERROR', 500);
    }

    try {
      const deleted = await prisma.webhook.deleteMany({
        where: { id, username: normalized },
      });
      if (deleted.count === 0) throw gqlError('Webhook not found', 'NOT_FOUND', 404);
      return { ok: true, deleted: true };
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      logger.error(err, '[graphql] deleteWebhook mutation failed');
      throw gqlError('Failed to delete webhook', 'INTERNAL_ERROR', 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function serializeUser(row) {
  return {
    username: row.username,
    address: row.address,
    memoType: row.memoType || null,
    memo: row.memo || null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt || null,
    flaggedAt: row.flaggedAt instanceof Date ? row.flaggedAt.toISOString() : row.flaggedAt || null,
    deletedAt: row.deletedAt instanceof Date ? row.deletedAt.toISOString() : row.deletedAt || null,
  };
}

function serializeWebhook(row) {
  return {
    id: row.id,
    username: row.username,
    url: row.url,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt || null,
    lastSentAt: row.lastSentAt instanceof Date ? row.lastSentAt.toISOString() : row.lastSentAt || null,
    failingSince: row.failingSince instanceof Date ? row.failingSince.toISOString() : row.failingSince || null,
  };
}

function isValidWebhookUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const resolvers = {
  Query,
  Mutation,
  User: UserResolver,
};

module.exports = { resolvers };

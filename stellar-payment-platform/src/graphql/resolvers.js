'use strict';

const crypto = require('crypto');
const { GraphQLError, GraphQLScalarType, Kind } = require('graphql');
const { prisma } = require('../../prismaClient');
const { normalizeNameTag } = require('../utils');

// ──────────────────────────────────────────────────────────────────────────
// DateTime scalar
// ──────────────────────────────────────────────────────────────────────────

const parseDateTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid DateTime value');
  return date;
};

const dateTime = new GraphQLScalarType({
  name: 'DateTime',
  description: 'ISO-8601 date-time string',
  serialize: (value) => parseDateTime(value).toISOString(),
  parseValue: parseDateTime,
  parseLiteral(node) {
    if (node.kind !== Kind.STRING) throw new TypeError('DateTime must be an ISO string');
    return parseDateTime(node.value);
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Auth helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Throw UNAUTHENTICATED when there is no authenticated user in context, or
 * when the authenticated user does not match the requested username.
 */
const unauthenticated = () => {
  throw new GraphQLError('Authentication required', {
    extensions: { code: 'UNAUTHENTICATED' },
  });
};

/**
 * Require an authenticated user. If `username` is provided the authenticated
 * user must also own that username (or be an admin).
 *
 * @param {object} context
 * @param {string|null|undefined} username
 * @returns {object} the authenticated user record
 */
const requireUser = (context, username) => {
  if (!context.user) unauthenticated();
  if (username && !context.isAdmin && context.user.username !== username) unauthenticated();
  return context.user;
};

/**
 * Require an admin context (x-api-key matches ADMIN_API_KEY).
 */
const requireAdmin = (context) => {
  if (!context.isAdmin) {
    throw new GraphQLError('Forbidden: admin access required', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
};

// ──────────────────────────────────────────────────────────────────────────
// Shared Prisma helpers
// ──────────────────────────────────────────────────────────────────────────

/** Base `where` clause that excludes soft-deleted records. */
const userWhere = (username) => ({ username, deletedAt: null });

/** Server uptime epoch — captured at module load. */
const SERVER_START_TIME = Date.now();

// ──────────────────────────────────────────────────────────────────────────
// Resolvers
// ──────────────────────────────────────────────────────────────────────────

const resolvers = {
  DateTime: dateTime,

  // ── Field resolvers ──────────────────────────────────────────────────────

  User: {
    webhooks: (user) =>
      prisma.webhook.findMany({
        where: { username: user.username },
        orderBy: { createdAt: 'desc' },
      }),
  },

  // ── Queries ──────────────────────────────────────────────────────────────

  Query: {
    /**
     * Look up a single user by username.
     */
    user: (_parent, { username }) =>
      prisma.user.findFirst({ where: userWhere(username) }),

    /**
     * Flat list of users, optionally filtered by a search string.
     * Returns at most 100 results.
     */
    users: (_parent, { search, limit, offset }) => {
      const where = {
        deletedAt: null,
        ...(search
          ? {
              OR: [
                { username: { contains: search, mode: 'insensitive' } },
                { address: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      return prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: Math.max(0, offset ?? 0),
        take: Math.min(100, Math.max(1, limit ?? 50)),
      });
    },

    /**
     * Paginated list of users with full page metadata.
     */
    usersPage: async (_parent, { search, page, limit }) => {
      const safePage = Math.max(1, page ?? 1);
      const safeLimit = Math.min(100, Math.max(1, limit ?? 10));
      const skip = (safePage - 1) * safeLimit;

      const where = {
        deletedAt: null,
        ...(search
          ? {
              OR: [
                { username: { contains: search, mode: 'insensitive' } },
                { address: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const [totalCount, data] = await prisma.$transaction([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: safeLimit,
        }),
      ]);

      return {
        data,
        totalCount,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(totalCount / safeLimit),
      };
    },

    /**
     * List webhooks for a username. Requires authentication.
     * Admin users may omit the username to list all.
     */
    webhooks: (_parent, { username }, context) => {
      const owner = requireUser(context, username || context.user?.username);
      return prisma.webhook.findMany({
        where: { username: owner.username },
        orderBy: { createdAt: 'desc' },
      });
    },

    /**
     * Resolve a Stellar address to its registered username tag.
     */
    lookupByAddress: async (_parent, { address }) => {
      const row = await prisma.user.findFirst({
        where: { address, deletedAt: null },
        select: { username: true, address: true },
      });
      return row ? { username: row.username, address: row.address } : null;
    },

    /**
     * Federation lookup — mirrors the /federation REST endpoint.
     * Resolves a name tag OR a Stellar address to a full FederationResult.
     */
    resolveTag: async (_parent, { q, type }) => {
      const lookupType = type || 'name';

      if (lookupType === 'id') {
        // Resolve address → tag
        const row = await prisma.user.findFirst({
          where: { address: { equals: q, mode: 'insensitive' }, deletedAt: null },
          select: { username: true, address: true, memoType: true, memo: true, flaggedAt: true },
        });

        if (!row) return null;

        if (row.flaggedAt) {
          throw new GraphQLError('Address is blocked', {
            extensions: { code: 'FORBIDDEN' },
          });
        }

        return {
          stellarAddress: `${row.username}*${process.env.DOMAIN || 'localhost'}`,
          accountId: row.address,
          memoType: row.memoType || null,
          memo: row.memo || null,
        };
      }

      // Resolve name → address
      const normalized = normalizeNameTag(q).toLowerCase();
      const row = await prisma.user.findFirst({
        where: { username: normalized, deletedAt: null },
        select: { username: true, address: true, memoType: true, memo: true, flaggedAt: true },
      });

      if (!row) return null;

      if (row.flaggedAt) {
        throw new GraphQLError('Address is blocked', {
          extensions: { code: 'FORBIDDEN' },
        });
      }

      return {
        stellarAddress: `${row.username}*${process.env.DOMAIN || 'localhost'}`,
        accountId: row.address,
        memoType: row.memoType || null,
        memo: row.memo || null,
      };
    },

    /**
     * Platform-level statistics.
     */
    stats: async () => {
      const [totalRegisteredUsers, activeTokens] = await prisma.$transaction([
        prisma.user.count(),
        prisma.user.count({ where: { flaggedAt: null, deletedAt: null } }),
      ]);

      return {
        totalRegisteredUsers,
        activeTokens,
        platformUptimeSeconds: Math.floor(process.uptime()),
        platformUptimeStartedAt: new Date(SERVER_START_TIME),
      };
    },
  },

  // ── Mutations ─────────────────────────────────────────────────────────────

  Mutation: {
    /**
     * Register a new username ↔ Stellar address mapping.
     * Does NOT require authentication so new users can self-register.
     */
    registerUser: (_parent, { input }) =>
      prisma.user.create({
        data: {
          username: String(input.username).trim().toLowerCase(),
          address: input.address.trim(),
          ...(input.memoType ? { memoType: input.memoType, memo: input.memo } : {}),
        },
      }),

    /**
     * Soft-delete a user (sets deletedAt). Owner-only.
     */
    deleteUser: (_parent, { username }, context) => {
      requireUser(context, username);
      return prisma.user
        .update({
          where: { username },
          data: { deletedAt: new Date() },
        })
        .then(() => true);
    },

    /**
     * Update memo fields for an existing user. Owner-only.
     */
    updateUser: async (_parent, { username, input }, context) => {
      requireUser(context, username);

      // Explicit null clears the field; undefined means "leave unchanged"
      const data = {};
      if ('memoType' in input) data.memoType = input.memoType ?? null;
      if ('memo' in input) data.memo = input.memo ?? null;

      const user = await prisma.user.findFirst({ where: userWhere(username) });
      if (!user) {
        throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
      }

      return prisma.user.update({ where: { username }, data });
    },

    /**
     * Flag/block a Stellar address. Admin-only.
     */
    flagUser: async (_parent, { username }, context) => {
      requireAdmin(context);

      const user = await prisma.user.findFirst({ where: { username } });
      if (!user) {
        throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
      }

      return prisma.user.update({
        where: { username },
        data: { flaggedAt: new Date() },
      });
    },

    /**
     * Register a webhook URL for a username. Owner-only.
     */
    createWebhook: (_parent, { username, url }, context) => {
      requireUser(context, username);

      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new GraphQLError('Webhook URL must be valid HTTP or HTTPS', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new GraphQLError('Webhook URL must be valid HTTP or HTTPS', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      return prisma.webhook.create({
        data: {
          username,
          url,
          secret: crypto.randomBytes(32).toString('hex'),
        },
      });
    },

    /**
     * Delete a webhook by id. The webhook must belong to the authenticated user.
     */
    deleteWebhook: (_parent, { id }, context) => {
      const owner = requireUser(context);
      return prisma.webhook
        .deleteMany({ where: { id, username: owner.username } })
        .then((result) => result.count > 0);
    },
  },
};

module.exports = { resolvers, requireUser, requireAdmin };

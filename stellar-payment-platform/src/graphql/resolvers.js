'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { GraphQLError } = require('graphql');
const { StrKey } = require('@stellar/stellar-sdk');
const Filter = require('bad-words');
const xss = require('xss');

const { verifyMultiSignerThreshold } = require('../multisigner-verifier');
const { verifyFreighterSignedMessage } = require('./stellar-signature');
const {
  normalizeNameTag,
  validateMemo,
  RESERVED_NAMES,
  USER_DATABASE,
} = require('../utils');

// Reserved local-name parts that no one may register, mirroring server.js.
const RESERVED_USERNAMES = [
  'admin',
  'root',
  'stellar',
  'system',
  'superuser',
  'administrator',
  'support',
];

const DEFAULT_DOMAIN = process.env.DOMAIN || 'localhost';

// Profanity filter is stateless; one instance is reused across requests.
const profanityFilter = new Filter();

/**
 * Throws a GraphQLError carrying a machine-readable `code` that mirrors the
 * REST error envelope (INVALID_INPUT, UNAUTHENTICATED, FORBIDDEN, ...). The
 * code is the stable part of the contract clients branch on.
 */
function gqlError(code, message) {
  return new GraphQLError(message || code, { extensions: { code } });
}

/** Normalises a Date (or ISO string) to an ISO string, or null when absent. */
const toIso = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

/** Maps a Prisma User row onto the GraphQL User type. */
function serializeUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    address: user.address,
    memoType: user.memoType ?? null,
    memo: user.memo ?? null,
    // createdAt is non-null in the schema; fall back to now() so a mock or a
    // row without a timestamp never violates the non-null contract.
    createdAt: toIso(user.createdAt) || new Date().toISOString(),
    flaggedAt: toIso(user.flaggedAt),
    deletedAt: toIso(user.deletedAt),
    federationAddress: user.username && user.username.includes('*')
      ? user.username
      : normalizeNameTag(user.username),
    isFlagged: Boolean(user.flaggedAt),
    isDeleted: Boolean(user.deletedAt),
  };
}

/** Maps a Prisma Webhook row onto the GraphQL Webhook type. */
function serializeWebhook(webhook, { includeSecret = false } = {}) {
  if (!webhook) return null;
  return {
    id: webhook.id,
    username: webhook.username,
    url: webhook.url,
    // The signing secret is sensitive: only exposed once, on creation.
    secret: includeSecret ? webhook.secret : null,
    createdAt: toIso(webhook.createdAt) || new Date().toISOString(),
    lastSentAt: toIso(webhook.lastSentAt),
    failingSince: toIso(webhook.failingSince),
  };
}

/** http(s) URLs up to 2048 chars are the only webhook targets accepted. */
function isValidWebhookUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Builds the search WHERE clause shared by the listing resolvers. */
const buildUserSearchWhere = (search) => {
  if (!search) return { deletedAt: null };
  return {
    deletedAt: null,
    OR: [
      { username: { contains: search, mode: 'insensitive' } },
      { address: { contains: search, mode: 'insensitive' } },
    ],
  };
};

/**
 * Verifies a wallet signature authorising an operation on the user's account.
 *
 * Two flows are supported, matching the REST webhook handlers:
 *   - a bare public key passed as `signature` (with no `signerAddress`) uses
 *     the multi-signer threshold verifier;
 *   - anything else is treated as a Freighter signed message and verified
 *     against the registered account's public key.
 *
 * Admin context (`context.isAdmin`) bypasses this check entirely.
 */
async function assertWebhookSignature({ userRecord, signature, signerAddress, operation = 'webhook' }) {
  if (!signature) throw gqlError('UNAUTHENTICATED', 'Signature required');

  if (StrKey.isValidEd25519PublicKey(signature) && !signerAddress) {
    const result = await verifyMultiSignerThreshold(
      userRecord.address,
      [signature],
      { operationType: 'management' },
    );
    if (!result.success) {
      throw gqlError('UNAUTHENTICATED', result.errorMessage || 'Signature verification failed');
    }
    return;
  }

  verifyFreighterSignedMessage({
    message: `${operation}:${userRecord.username}`,
    signature,
    signerAddress,
    publicKey: userRecord.address,
  });
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------
const resolvers = {
  Query: {
    user: async (_, { username }, context) => {
      const row = await context.prisma.user.findFirst({
        where: { username, deletedAt: null },
      });
      return serializeUser(row);
    },

    userByAddress: async (_, { address }, context) => {
      const row = await context.prisma.user.findFirst({
        where: { address: { equals: address, mode: 'insensitive' }, deletedAt: null },
      });
      return serializeUser(row);
    },

    users: async (_, { search, page, limit }, context) => {
      const safePage = Math.max(1, page || 1);
      const safeLimit = Math.min(100, Math.max(1, limit || 10));
      const skip = (safePage - 1) * safeLimit;
      const where = buildUserSearchWhere(search);

      const [totalCount, rows] = await context.prisma.$transaction([
        context.prisma.user.count({ where }),
        context.prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: safeLimit,
        }),
      ]);

      return {
        data: rows.map(serializeUser),
        totalCount,
        totalPages: Math.ceil(totalCount / safeLimit) || 0,
        currentPage: safePage,
        limit: safeLimit,
      };
    },

    federation: async (_, { q, type = 'name' }, context) => {
      const { federationLookupCached, federationNameKey, federationIdKey } = context.cache;

      if (type === 'id') {
        const cacheKey = federationIdKey(q);
        const cached = await federationLookupCached(cacheKey, async () => {
          const row = await context.prisma.user.findFirst({
            where: { address: { equals: q, mode: 'insensitive' }, deletedAt: null },
            select: { username: true, address: true, memoType: true, memo: true },
          });
          if (!row) return null;
          const response = {
            stellar_address: `${row.username}*${DEFAULT_DOMAIN}`,
            account_id: row.address,
          };
          if (row.memoType) {
            response.memo_type = row.memoType;
            response.memo = row.memo;
          }
          return response;
        });
        if (!cached) return null;
        return {
          stellarAddress: cached.stellar_address,
          accountId: cached.account_id,
          memoType: cached.memo_type || null,
          memo: cached.memo || null,
        };
      }

      if (type === 'name') {
        const queryName = normalizeNameTag(q).toLowerCase();
        const cacheKey = federationNameKey(queryName);
        const cached = await federationLookupCached(cacheKey, async () => {
          const row = await context.prisma.user.findFirst({
            where: { username: queryName, deletedAt: null },
            select: { address: true, memoType: true, memo: true },
          });
          const address = row?.address || USER_DATABASE[queryName];
          if (!address) return null;
          const response = { stellar_address: address, account_id: address };
          if (row?.memoType) {
            response.memo_type = row.memoType;
            response.memo = row.memo;
          }
          return response;
        });
        if (!cached) return null;
        return {
          stellarAddress: cached.stellar_address,
          accountId: cached.account_id,
          memoType: cached.memo_type || null,
          memo: cached.memo || null,
        };
      }

      throw gqlError('INVALID_INPUT', "Unsupported query type. Supported types: 'id', 'name'");
    },

    stats: async (_, __, context) => {
      const [totalRegisteredUsers, activeTokens] = await context.prisma.$transaction([
        context.prisma.user.count(),
        context.prisma.user.count({ where: { flaggedAt: null } }),
      ]);
      const uptimeSeconds = Math.floor(process.uptime());
      return {
        totalRegisteredUsers,
        activeTokens,
        platformUptimeSeconds: uptimeSeconds,
        platformUptimeStartedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
      };
    },

    webhooks: async (_, args, context) => {
      const normalizedUsername = normalizeNameTag(args.username).toLowerCase();
      const userRecord = await context.prisma.user.findUnique({
        where: { username: normalizedUsername },
        select: { username: true, address: true },
      });
      if (!userRecord) throw gqlError('NOT_FOUND', 'Username not registered');

      if (!context.isAdmin) {
        await assertWebhookSignature({
          userRecord,
          signature: args.signature,
          signerAddress: args.signerAddress,
          operation: args.operation,
        });
      }

      const webhooks = await context.prisma.webhook.findMany({
        where: { username: userRecord.username },
        orderBy: { createdAt: 'desc' },
      });
      return webhooks.map((w) => serializeWebhook(w));
    },
  },

  Mutation: {
    registerUser: async (_, { input }, context) => {
      const safeUsername = xss(input.username);
      const username = normalizeNameTag(safeUsername);
      const { address } = input;

      if (address && address.toUpperCase().startsWith('S')) {
        throw gqlError(
          'INVALID_INPUT',
          'Never share your Secret Key. Please register using your Public Key (starts with G).',
        );
      }
      if (!StrKey.isValidEd25519PublicKey(address)) {
        throw gqlError('INVALID_INPUT', 'Invalid Stellar Public Key format.');
      }

      const memoError = validateMemo(input.memoType, input.memo);
      if (memoError) throw gqlError('INVALID_INPUT', memoError);

      const usernameLocalPart = username.includes('*') ? username.split('*')[0] : username;
      if (profanityFilter.isProfane(usernameLocalPart)) {
        throw gqlError('INVALID_INPUT', 'Username contains restricted words');
      }

      const normalizedUsername = username.toLowerCase();
      const normalizedLocalPart = normalizedUsername.includes('*')
        ? normalizedUsername.split('*')[0]
        : normalizedUsername;
      if (
        RESERVED_USERNAMES.includes(normalizedLocalPart) ||
        RESERVED_NAMES.includes(normalizedUsername)
      ) {
        throw gqlError('FORBIDDEN', 'This username is reserved and cannot be registered.');
      }

      const existing = await context.prisma.user.findFirst({
        where: { address, deletedAt: null },
      });
      if (existing) throw gqlError('CONFLICT', 'Address already registered');

      // Signature verification reuses the shared multi-signer threshold
      // service. A bare public key signature, an explicit signer address, or
      // the account itself are all accepted as the signer to check.
      let verification = null;
      const signerToVerify =
        input.signerAddress ||
        (input.signature && StrKey.isValidEd25519PublicKey(input.signature) ? input.signature : address);
      if (signerToVerify) {
        const result = await verifyMultiSignerThreshold(address, [signerToVerify], {
          operationType: 'management',
        });
        verification = {
          accountId: result.accountId,
          signerCount: result.signerCount,
          thresholdMet: result.success,
          requiredThreshold: result.requiredThreshold,
          providedWeight: result.totalWeight,
        };
        if (!result.success) {
          throw gqlError('UNAUTHENTICATED', result.errorMessage || 'Signature verification failed');
        }
      }

      const created = await context.prisma.user.create({
        data: {
          username: normalizedUsername,
          address,
          ...(input.memoType ? { memoType: input.memoType, memo: input.memo } : {}),
        },
      });
      context.cache.invalidateFederationCache(normalizedUsername, address);

      return { ok: true, user: serializeUser(created), verification };
    },

    unregisterUser: async (_, { username }, context) => {
      const normalized = normalizeNameTag(username).toLowerCase();
      const existing = await context.prisma.user.findFirst({
        where: { username: normalized, deletedAt: null },
      });
      if (!existing) throw gqlError('NOT_FOUND', 'Username not found or already deleted');

      await context.prisma.user.update({
        where: { username: normalized },
        data: { deletedAt: new Date() },
      });
      context.cache.invalidateFederationCache(normalized, existing.address);

      return { ok: true, deleted: true };
    },

    // Admin-only: flags (blocks) an address. The auth check lives here rather
    // than in a directive so the requirement is explicit and testable.
    blockUser: async (_, { address }, context) => {
      if (!context.isAdmin) {
        throw gqlError('FORBIDDEN', 'Admin API key required to block an address');
      }
      let updated;
      try {
        updated = await context.prisma.user.update({
          where: { address },
          data: { flaggedAt: new Date() },
        });
      } catch (err) {
        if (err.code === 'P2025') throw gqlError('NOT_FOUND', 'Address not found');
        throw err;
      }
      context.cache.invalidateFederationCache(updated.username, updated.address);
      return serializeUser(updated);
    },

    createWebhook: async (_, { input }, context) => {
      const normalizedUsername = normalizeNameTag(input.username).toLowerCase();
      const userRecord = await context.prisma.user.findUnique({
        where: { username: normalizedUsername },
        select: { username: true, address: true },
      });
      if (!userRecord) throw gqlError('NOT_FOUND', 'Username not registered');

      if (!context.isAdmin) {
        await assertWebhookSignature({
          userRecord,
          signature: input.signature,
          signerAddress: input.signerAddress,
          operation: input.operation,
        });
      }

      if (!isValidWebhookUrl(input.url)) {
        throw gqlError('INVALID_INPUT', 'Invalid webhook URL. Must be http or https.');
      }

      const secret = crypto.randomBytes(32).toString('hex');
      const id = uuidv4();
      const now = new Date();

      let webhook;
      try {
        webhook = await context.prisma.webhook.create({
          data: {
            id,
            username: userRecord.username,
            url: input.url,
            secret,
            createdAt: now,
          },
        });
      } catch (err) {
        if (err.code === 'P2002') {
          throw gqlError('CONFLICT', 'A webhook with this URL is already registered for the user.');
        }
        throw err;
      }

      return {
        ok: true,
        webhook: serializeWebhook(webhook, { includeSecret: true }),
        note: 'Save the secret securely — it will only be returned once. Signatures for webhook payloads are computed with HMAC-SHA256 using this secret.',
      };
    },

    deleteWebhook: async (_, args, context) => {
      const normalizedUsername = normalizeNameTag(args.username).toLowerCase();
      const userRecord = await context.prisma.user.findUnique({
        where: { username: normalizedUsername },
        select: { username: true, address: true },
      });
      if (!userRecord) throw gqlError('NOT_FOUND', 'Username not registered');

      if (!context.isAdmin) {
        await assertWebhookSignature({
          userRecord,
          signature: args.signature,
          signerAddress: args.signerAddress,
          operation: args.operation,
        });
      }

      if (!args.id) throw gqlError('INVALID_INPUT', 'Webhook id is required');

      const deleted = await context.prisma.webhook.deleteMany({
        where: { id: args.id, username: userRecord.username },
      });
      if (deleted.count === 0) throw gqlError('NOT_FOUND', 'Webhook not found');

      return { ok: true, deleted: true };
    },
  },

  // Relation resolvers mirror the Prisma relations: User.webhooks and
  // Webhook.user. They resolve lazily, so a client only pays for the relation
  // when it asks for it — the over/under-fetching win GraphQL is here for.
  User: {
    webhooks: async (parent, _, context) =>
      context.prisma.webhook.findMany({ where: { username: parent.username } }),
  },

  Webhook: {
    user: async (parent, _, context) =>
      serializeUser(
        await context.prisma.user.findUnique({ where: { username: parent.username } }),
      ),
  },
};

module.exports = resolvers;

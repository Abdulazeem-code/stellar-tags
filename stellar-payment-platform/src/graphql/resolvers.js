'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const xss = require('xss');
const { StrKey } = require('@stellar/stellar-sdk');
const { GraphQLError } = require('graphql');

const { prisma } = require('../../prismaClient');
const { poolGet, poolRun, poolAll } = require('../db');
const { logger } = require('../logger');
const {
  normalizeNameTag,
  validateMemo,
  RESERVED_NAMES,
  shouldFallbackToLocalRegistry,
  USER_DATABASE,
} = require('../utils');
const {
  lookupCached,
  federationNameKey,
  federationIdKey,
  federationLookupCached,
  invalidateFederationCache,
} = require('../cache');

// ---------------------------------------------------------------------------
// Helper: throw a GraphQL-friendly error
// ---------------------------------------------------------------------------
/**
 * Raise a user-facing GraphQL error with a stable code extension.
 *
 * @param {string} message - Human-readable message.
 * @param {string} code - Machine-readable code (mirrors ApiError codes).
 * @param {number} [http] - Suggested HTTP status for clients that care.
 */
const throwGQL = (message, code, http = 400) => {
  throw new GraphQLError(message, {
    extensions: { code, http: { status: http } },
  });
};

// ---------------------------------------------------------------------------
// SQLite fallback helpers (mirrors server.js / userRoutes.js)
// ---------------------------------------------------------------------------
const getLocalUserByAddress = (address) =>
  poolGet(
    'SELECT username, address FROM username_registry WHERE address = ? LIMIT 1',
    [address],
  );

const getLocalUserByUsername = (username) =>
  poolGet(
    'SELECT username, address FROM username_registry WHERE username = ? LIMIT 1',
    [username],
  );

const registerLocalUser = async ({ username, address }) => {
  const existingByAddress = await getLocalUserByAddress(address);
  if (existingByAddress) throwGQL('Address already registered', 'CONFLICT', 409);

  const existingByUsername = await getLocalUserByUsername(username);
  if (existingByUsername) throwGQL('Username is already taken. Please choose another.', 'CONFLICT', 409);

  await poolRun(
    `INSERT INTO username_registry (username, address, created_at) VALUES (?, ?, ?)`,
    [username, address, new Date().toISOString()],
  );
};

// ---------------------------------------------------------------------------
// Helper: build a public User shape from a Prisma row
// ---------------------------------------------------------------------------
const serializeUser = (user) => ({
  username: user.username,
  address: user.address,
  federation_address: `${user.username}*${process.env.DOMAIN || 'localhost'}`,
  memo_type: user.memoType ?? null,
  memo: user.memo ?? null,
  created_at: user.createdAt instanceof Date
    ? user.createdAt
    : new Date(user.createdAt),
});

// ---------------------------------------------------------------------------
// Helper: serialize a Webhook row
// ---------------------------------------------------------------------------
const serializeWebhook = (w) => ({
  id: w.id,
  username: w.username,
  url: w.url,
  created_at: w.createdAt instanceof Date ? w.createdAt : new Date(w.createdAt),
  last_sent_at: w.lastSentAt
    ? (w.lastSentAt instanceof Date ? w.lastSentAt : new Date(w.lastSentAt))
    : null,
  failing_since: w.failingSince
    ? (w.failingSince instanceof Date ? w.failingSince : new Date(w.failingSince))
    : null,
});

// ---------------------------------------------------------------------------
// Webhook authentication (mirrors webhookRoutes.js authenticateWebhookCall)
// ---------------------------------------------------------------------------
const { verifyMultiSignerThreshold } = require('../multisigner-verifier');
const { Keypair } = require('@stellar/stellar-sdk');

const verifyFreighterSignedMessage = ({ message, signature, signerAddress, publicKey }) => {
  const claimedSigner = signerAddress || publicKey;

  if (!StrKey.isValidEd25519PublicKey(claimedSigner)) {
    throwGQL('Invalid signer address format.', 'UNAUTHENTICATED', 401);
  }

  const keypair = Keypair.fromPublicKey(claimedSigner);

  let signatureBuffer;
  if (Buffer.isBuffer(signature)) {
    signatureBuffer = signature;
  } else if (typeof signature === 'string') {
    signatureBuffer = Buffer.from(signature, 'base64');
  } else {
    throwGQL('Invalid message signature format.', 'UNAUTHENTICATED', 401);
  }

  const prefix = Buffer.from('Stellar Signed Message:\n', 'utf8');
  const messageBytes = Buffer.from(message, 'utf8');
  const payload = Buffer.concat([prefix, messageBytes]);
  const messageHash = crypto.createHash('sha256').update(payload).digest();

  if (!keypair.verify(messageHash, signatureBuffer)) {
    throwGQL('Signature verification failed.', 'UNAUTHENTICATED', 401);
  }

  if (claimedSigner !== publicKey) {
    throwGQL('Signer address does not match the registered account.', 'UNAUTHENTICATED', 401);
  }

  return claimedSigner;
};

/**
 * Verify webhook ownership via Stellar signature.
 * Returns the user record on success.
 *
 * @param {{ username: string, signature: string, signerAddress?: string, operation?: string }} args
 */
const authenticateWebhookOwner = async ({ username: rawUsername, signature, signerAddress, operation = 'webhook' }) => {
  if (!rawUsername) throwGQL('Missing required field: username.', 'INVALID_INPUT', 400);
  if (!signature) throwGQL('Missing required field: signature.', 'INVALID_INPUT', 400);

  const normalizedUsername = normalizeNameTag(rawUsername).toLowerCase();

  let userRecord;
  try {
    userRecord = await prisma.user.findUnique({
      where: { username: normalizedUsername },
      select: { username: true, address: true },
    });
  } catch (err) {
    if (!shouldFallbackToLocalRegistry(err)) throw err;
    const localRow = await poolGet(
      'SELECT username, address FROM username_registry WHERE username = ? LIMIT 1',
      [normalizedUsername],
    );
    userRecord = localRow ? { username: localRow.username, address: localRow.address } : null;
  }

  if (!userRecord) throwGQL('Username not registered.', 'NOT_FOUND', 404);

  const message = `${operation}:${normalizedUsername}`;

  if (StrKey.isValidEd25519PublicKey(signature) && !signerAddress) {
    const result = await verifyMultiSignerThreshold(userRecord.address, [signature], {
      operationType: 'management',
    });
    if (!result.success) {
      throwGQL(result.errorMessage || 'Signature verification failed', 'UNAUTHENTICATED', 401);
    }
  } else {
    verifyFreighterSignedMessage({
      message,
      signature,
      signerAddress,
      publicKey: userRecord.address,
    });
  }

  return userRecord;
};

const isValidWebhookUrl = (url) => {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Custom scalar: DateTime
// ---------------------------------------------------------------------------
const { GraphQLScalarType, Kind } = require('graphql');

const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  description: 'ISO-8601 UTC date-time string',
  serialize(value) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return new Date(value).toISOString();
  },
  parseValue(value) {
    return new Date(value);
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING) return new Date(ast.value);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

const resolvers = {
  DateTime: DateTimeScalar,

  // ── Field resolvers ──────────────────────────────────────────────────────

  User: {
    /**
     * Resolve webhooks for a User.
     * Only returned when explicitly requested in the query, and only when the
     * requester is authenticated as the same user (context.stellarAddress matches).
     */
    webhooks: async (parent, _args, context) => {
      // Guard: only the owning user can see their webhooks
      if (!context.stellarAddress) return null;

      const ownerAddress = parent.address;
      if (context.stellarAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
        return null;
      }

      try {
        const rows = await prisma.webhook.findMany({
          where: { username: parent.username },
          orderBy: { createdAt: 'desc' },
        });
        return rows.map(serializeWebhook);
      } catch (err) {
        if (!shouldFallbackToLocalRegistry(err)) throw err;
        const rows = await poolAll(
          `SELECT id, username, url, created_at, last_sent_at, failing_since
           FROM webhooks WHERE username = ? ORDER BY created_at DESC`,
          [parent.username],
        );
        return rows.map((r) => ({
          id: r.id,
          username: r.username,
          url: r.url,
          created_at: new Date(r.created_at),
          last_sent_at: r.last_sent_at ? new Date(r.last_sent_at) : null,
          failing_since: r.failing_since ? new Date(r.failing_since) : null,
        }));
      }
    },
  },

  // ── Queries ──────────────────────────────────────────────────────────────

  Query: {
    /**
     * Federation lookup — mirrors GET /federation.
     * type='name' (default): resolve username tag → stellar address.
     * type='id': resolve stellar address → username.
     */
    federation: async (_root, { q: queryValue, type }) => {
      const lookupType = type || 'name';

      if (lookupType === 'id') {
        const cacheKey = federationIdKey(queryValue);
        const result = await federationLookupCached(cacheKey, async () => {
          const row = await prisma.user.findFirst({
            where: { address: { equals: queryValue, mode: 'insensitive' }, deletedAt: null },
            select: { username: true, address: true, memoType: true, memo: true, flaggedAt: true },
          });

          if (!row) return null;
          if (row.flaggedAt) throwGQL('Address is blocked', 'FORBIDDEN', 403);

          const response = {
            stellar_address: `${row.username}*${process.env.DOMAIN || 'localhost'}`,
            account_id: row.address,
            memo_type: row.memoType ?? null,
            memo: row.memo ?? null,
          };
          return response;
        });

        if (!result) throwGQL('Address not found', 'NOT_FOUND', 404);
        return result;
      }

      if (lookupType === 'name' || !lookupType) {
        const nameTag = normalizeNameTag(queryValue);
        const queryName = nameTag.toLowerCase();
        const cacheKey = federationNameKey(queryName);

        const result = await federationLookupCached(cacheKey, async () => {
          let row;
          try {
            row = await prisma.user.findFirst({
              where: { username: queryName, deletedAt: null },
              select: { address: true, memoType: true, memo: true, flaggedAt: true },
            });

            if (row?.flaggedAt) throwGQL('Address is blocked', 'FORBIDDEN', 403);
          } catch (error) {
            if (error instanceof GraphQLError) throw error;
            if (!shouldFallbackToLocalRegistry(error)) throw error;
            const localRow = await getLocalUserByUsername(queryName);
            row = localRow ? { address: localRow.address, memoType: null, memo: null } : null;
          }

          const address = row?.address || USER_DATABASE[queryName];
          if (!address) return null;

          return {
            stellar_address: address,
            account_id: address,
            memo_type: row?.memoType ?? null,
            memo: row?.memo ?? null,
          };
        });

        if (!result) throwGQL('Name tag not found', 'NOT_FOUND', 404);
        return result;
      }

      throwGQL("Unsupported query type. Supported types: 'id', 'name'", 'INVALID_INPUT', 400);
    },

    /**
     * Resolve a Stellar address to its registered user — mirrors GET /lookup?address=…
     */
    lookupUser: async (_root, { address }) => {
      const result = await lookupCached(address, async () => {
        let row;
        try {
          row = await prisma.user.findFirst({
            where: { address, deletedAt: null },
          });
        } catch (err) {
          if (!shouldFallbackToLocalRegistry(err)) throw err;
          row = await getLocalUserByAddress(address);
        }
        return row ? row : null;
      });

      if (!result) return null;
      return serializeUser(result);
    },

    /**
     * List users with optional search + pagination — mirrors GET /users.
     */
    listUsers: async (_root, { search = null, page: rawPage = 1, limit: rawLimit = 10 }) => {
      const page = Math.max(1, rawPage);
      const limit = Math.min(100, Math.max(1, rawLimit));
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
          prisma.user.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
          }),
        ]);

        const totalPages = Math.ceil(totalCount / limit);
        return {
          data: rows.map(serializeUser),
          meta: { total: totalCount, page, limit, totalPages },
        };
      } catch (err) {
        logger.error(err, '[GraphQL] listUsers error');
        throwGQL('Database error', 'INTERNAL_ERROR', 500);
      }
    },

    /**
     * Fetch a single user by username.
     */
    getUser: async (_root, { username: rawUsername }) => {
      const username = normalizeNameTag(rawUsername).toLowerCase();

      try {
        const user = await prisma.user.findFirst({
          where: { username, deletedAt: null },
        });
        return user ? serializeUser(user) : null;
      } catch (err) {
        if (!shouldFallbackToLocalRegistry(err)) throw err;
        const row = await getLocalUserByUsername(username);
        if (!row) return null;
        return {
          username: row.username,
          address: row.address,
          federation_address: `${row.username}*${process.env.DOMAIN || 'localhost'}`,
          memo_type: null,
          memo: null,
          created_at: new Date(row.created_at || Date.now()),
        };
      }
    },

    /**
     * Server time — useful as a lightweight liveness check from the frontend.
     */
    serverTime: () => new Date(),
  },

  // ── Mutations ────────────────────────────────────────────────────────────

  Mutation: {
    /**
     * Register a new user — mirrors POST /register.
     */
    registerUser: async (_root, { input }) => {
      const {
        username: rawUsername,
        address,
        memo_type: memoType,
        memo,
        signature = '',
        signerAddress = '',
      } = input;

      if (!rawUsername || !address) {
        throwGQL('username and address are required', 'INVALID_INPUT', 400);
      }

      if (address.toUpperCase().startsWith('S')) {
        throwGQL(
          'Never share your Secret Key. Please register using your Public Key (starts with G).',
          'INVALID_INPUT',
          400,
        );
      }

      if (!StrKey.isValidEd25519PublicKey(address)) {
        throwGQL('Invalid Stellar Public Key format.', 'INVALID_INPUT', 400);
      }

      const memoError = validateMemo(memoType, memo);
      if (memoError) throwGQL(memoError, 'INVALID_INPUT', 400);

      const safeUsername = xss(rawUsername);
      const normalized = normalizeNameTag(safeUsername).toLowerCase();

      if (RESERVED_NAMES.includes(normalized)) {
        throwGQL('This username is reserved and cannot be registered.', 'FORBIDDEN', 403);
      }

      // Check for existing registration
      let existing;
      try {
        existing = await prisma.user.findFirst({ where: { address, deletedAt: null } });
      } catch (err) {
        if (!shouldFallbackToLocalRegistry(err)) throw err;
        existing = await getLocalUserByAddress(address);
      }
      if (existing) throwGQL('Address already registered', 'CONFLICT', 409);

      // Optional signature verification
      if (signature) {
        const { verifyMultiSignerThreshold } = require('../multisigner-verifier');
        const signerToVerify = signerAddress || address;
        const result = await verifyMultiSignerThreshold(address, [signerToVerify], {
          operationType: 'management',
        });
        if (!result.success) {
          throwGQL(result.errorMessage || 'Signature verification failed', 'UNAUTHENTICATED', 401);
        }
      }

      // Persist
      try {
        await prisma.user.create({
          data: {
            username: normalized,
            address,
            ...(memoType && { memoType, memo }),
          },
        });
      } catch (err) {
        if (!shouldFallbackToLocalRegistry(err)) {
          if (err.code === 'P2002') throwGQL('Username is already taken. Please choose another.', 'CONFLICT', 409);
          throw err;
        }
        await registerLocalUser({ username: normalized, address });
      }

      invalidateFederationCache(normalized, address);

      return {
        ok: true,
        username: normalized,
        address,
        federation_address: `${normalized}*${process.env.DOMAIN || 'localhost'}`,
        memo_type: memoType ?? null,
        memo: memo ?? null,
      };
    },

    /**
     * Soft-delete a user registration — mirrors DELETE /register/:username.
     */
    deleteUser: async (_root, { username: rawUsername }) => {
      const username = normalizeNameTag(rawUsername).toLowerCase();
      if (!username) throwGQL('Missing username', 'INVALID_INPUT', 400);

      let existing;
      try {
        existing = await prisma.user.findFirst({ where: { username, deletedAt: null } });
      } catch (err) {
        logger.error(err, '[GraphQL] deleteUser lookup error');
        throwGQL('Database error', 'INTERNAL_ERROR', 500);
      }

      if (!existing) throwGQL('Username not found or already deleted', 'NOT_FOUND', 404);

      try {
        await prisma.user.update({
          where: { username },
          data: { deletedAt: new Date() },
        });
      } catch (err) {
        logger.error(err, '[GraphQL] deleteUser update error');
        throwGQL('Database error', 'INTERNAL_ERROR', 500);
      }

      invalidateFederationCache(username, existing.address);

      return { ok: true, username, deleted: true };
    },

    /**
     * Register a webhook — mirrors POST /webhooks.
     */
    registerWebhook: async (_root, { input }) => {
      const { username, url, signature, signerAddress, operation } = input;

      const user = await authenticateWebhookOwner({ username, signature, signerAddress, operation });

      if (!isValidWebhookUrl(url)) {
        throwGQL('Invalid webhook URL. Must be http or https.', 'INVALID_INPUT', 400);
      }

      const secret = crypto.randomBytes(32).toString('hex');
      const id = uuidv4();
      const now = new Date();

      let webhook;
      try {
        webhook = await prisma.webhook.create({
          data: { id, username: user.username, url, secret, createdAt: now },
        });
      } catch (err) {
        if (
          err?.code === 'P2002' &&
          Array.isArray(err.meta?.target) &&
          err.meta.target.includes('username') &&
          err.meta.target.includes('url')
        ) {
          throwGQL('A webhook with this URL is already registered for the user.', 'CONFLICT', 409);
        }
        if (!shouldFallbackToLocalRegistry(err)) throw err;

        await poolRun(
          `INSERT INTO webhooks (id, username, url, secret, created_at, last_sent_at, failing_since)
           VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
          [id, user.username, url, secret, now.toISOString()],
        );
        webhook = { id, username: user.username, url, createdAt: now.toISOString() };
      }

      return {
        ok: true,
        webhook: serializeWebhook(webhook),
        secret,
        note: 'Save the secret securely — it will only be returned once. Signatures for webhook payloads are computed with HMAC-SHA256 using this secret.',
      };
    },

    /**
     * Delete a webhook — mirrors DELETE /webhooks/:id.
     */
    deleteWebhook: async (_root, { input }) => {
      const { id, username, signature, signerAddress, operation } = input;

      if (!id) throwGQL('Webhook id is required.', 'INVALID_INPUT', 400);

      const user = await authenticateWebhookOwner({ username, signature, signerAddress, operation });

      let deletedCount;
      try {
        const deleted = await prisma.webhook.deleteMany({
          where: { id, username: user.username },
        });
        deletedCount = deleted.count;
      } catch (err) {
        if (!shouldFallbackToLocalRegistry(err)) throw err;
        const result = await poolRun(
          'DELETE FROM webhooks WHERE id = ? AND username = ?',
          [id, user.username],
        );
        deletedCount = result?.changes || 0;
      }

      if (deletedCount === 0) throwGQL('Webhook not found.', 'NOT_FOUND', 404);

      return { ok: true, deleted: true };
    },
  },
};

module.exports = { resolvers };

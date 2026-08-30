const express = require('express');
const crypto = require('crypto');
const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { requireJson } = require('../../middleware/requireJson');
const { createApiKeyBodySchema, revokeApiKeyBodySchema, rotateApiKeyBodySchema } = require('../../schemas');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../utils/jwt');

module.exports = (redisClient) => {
  const router = express.Router();
  const { logger } = require('../../logger');
  const { prisma } = require('../../../prismaClient');

  const KEY_PREFIX = 'sk_live_';
  const GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour default

  const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

  // Middleware: require a valid API key in the request
  const requireApiKey = asyncHandler(async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const apiKey = req.headers['x-api-key'];

    let token = apiKey;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    if (!token) {
      return next(new ApiError('UNAUTHENTICATED', 'API key required. Provide via X-Api-Key header or Authorization: Bearer <key>'));
    }

    const keyHash = hashKey(token);
    const record = await prisma.apiKey.findUnique({ where: { keyHash } });

    if (!record) {
      return next(new ApiError('UNAUTHENTICATED', 'Invalid API key'));
    }

    if (record.revokedAt) {
      return next(new ApiError('UNAUTHENTICATED', 'API key has been revoked'));
    }

    if (record.expiresAt && record.expiresAt < new Date()) {
      return next(new ApiError('UNAUTHENTICATED', 'API key has expired'));
    }

    // Update lastUsedAt (fire-and-forget)
    prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

    req.apiKeyRecord = record;
    next();
  });

  // POST /auth/api-keys
  // Generate a new API key
  router.post('/', requireAuth, requireJson, validateSchema({ body: createApiKeyBodySchema }), asyncHandler(async (req, res, next) => {
    try {
      const { name, owner_id, scopes: scopesStr, expires_in_hours } = req.body;

      const scopes = scopesStr.split(',').map((s) => s.trim()).filter(Boolean);
      const rawKey = KEY_PREFIX + crypto.randomBytes(32).toString('hex');
      const keyHash = hashKey(rawKey);
      const keyPrefix = rawKey.slice(0, 12);

      const expiresAt = expires_in_hours
        ? new Date(Date.now() + expires_in_hours * 60 * 60 * 1000)
        : null;

      const record = await prisma.apiKey.create({
        data: {
          name,
          ownerId: owner_id,
          keyHash,
          keyPrefix,
          scopes: scopes.length > 0 ? scopes : ['read', 'write'],
          expiresAt,
        },
      });

      logger.info(`[Correlation ID: ${req.correlationId}] API key created: ${record.id} for owner ${owner_id}`);

      return res.status(201).json({
        success: true,
        data: {
          id: record.id,
          name: record.name,
          key: rawKey,
          key_prefix: record.keyPrefix,
          owner_id: record.ownerId,
          scopes: record.scopes,
          expires_at: record.expiresAt,
          created_at: record.createdAt,
        },
        message: 'Save this API key securely. It will not be shown again.',
      });
    } catch (err) {
      return next(err);
    }
  }));

  // GET /auth/api-keys
  // List API keys for an owner
  router.get('/', requireAuth, asyncHandler(async (req, res, next) => {
    try {
      const ownerId = req.query.owner_id;
      if (!ownerId) {
        return next(new ApiError('INVALID_INPUT', 'owner_id query parameter is required'));
      }

      const keys = await prisma.apiKey.findMany({
        where: { ownerId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          ownerId: true,
          scopes: true,
          expiresAt: true,
          revokedAt: true,
          revokedBy: true,
          lastUsedAt: true,
          createdAt: true,
        },
      });

      return res.json({ success: true, data: keys });
    } catch (err) {
      return next(err);
    }
  }));

  // POST /auth/api-keys/:id/revoke
  // Revoke a specific API key
  router.post('/:id/revoke', requireAuth, requireJson, validateSchema({ body: revokeApiKeyBodySchema }), asyncHandler(async (req, res, next) => {
    try {
      const { id } = req.params;
      const { revoked_by } = req.body;

      const record = await prisma.apiKey.findUnique({ where: { id } });

      if (!record) {
        return next(new ApiError('NOT_FOUND', 'API key not found'));
      }

      if (record.revokedAt) {
        return next(new ApiError('CONFLICT', 'API key is already revoked'));
      }

      const updated = await prisma.apiKey.update({
        where: { id },
        data: {
          revokedAt: new Date(),
          revokedBy: revoked_by,
        },
      });

      logger.info(`[Correlation ID: ${req.correlationId}] API key revoked: ${id} by ${revoked_by}`);

      return res.json({
        success: true,
        data: {
          id: updated.id,
          name: updated.name,
          revoked_at: updated.revokedAt,
          revoked_by: updated.revokedBy,
        },
      });
    } catch (err) {
      return next(err);
    }
  }));

  // POST /auth/api-keys/:id/rotate
  // Rotate an API key: generate new key, revoke old one with grace period
  router.post('/:id/rotate', requireAuth, requireJson, validateSchema({ body: rotateApiKeyBodySchema }), asyncHandler(async (req, res, next) => {
    try {
      const { id } = req.params;
      const { name, grace_period_hours = 1 } = req.body;

      const oldRecord = await prisma.apiKey.findUnique({ where: { id } });

      if (!oldRecord) {
        return next(new ApiError('NOT_FOUND', 'API key not found'));
      }

      if (oldRecord.revokedAt) {
        return next(new ApiError('CONFLICT', 'API key is already revoked'));
      }

      // Generate new key
      const rawKey = KEY_PREFIX + crypto.randomBytes(32).toString('hex');
      const keyHash = hashKey(rawKey);
      const keyPrefix = rawKey.slice(0, 12);

      // Revoke old key with grace period
      const graceExpiresAt = new Date(Date.now() + grace_period_hours * 60 * 60 * 1000);

      const [newRecord] = await prisma.$transaction([
        prisma.apiKey.create({
          data: {
            name: name || oldRecord.name,
            ownerId: oldRecord.ownerId,
            keyHash,
            keyPrefix,
            scopes: oldRecord.scopes,
            expiresAt: oldRecord.expiresAt,
          },
        }),
        prisma.apiKey.update({
          where: { id },
          data: {
            revokedAt: new Date(),
            revokedBy: 'rotation',
          },
        }),
      ]);

      logger.info(`[Correlation ID: ${req.correlationId}] API key rotated: ${id} -> ${newRecord.id} (grace period: ${grace_period_hours}h)`);

      return res.status(201).json({
        success: true,
        data: {
          new_key: {
            id: newRecord.id,
            name: newRecord.name,
            key: rawKey,
            key_prefix: newRecord.keyPrefix,
            owner_id: newRecord.ownerId,
            scopes: newRecord.scopes,
            expires_at: newRecord.expiresAt,
            created_at: newRecord.createdAt,
          },
          old_key: {
            id: oldRecord.id,
            revoked_at: new Date(),
            grace_period_expires_at: graceExpiresAt,
          },
        },
        message: 'New API key created. Old key will remain active during the grace period.',
      });
    } catch (err) {
      return next(err);
    }
  }));

  return router;
};

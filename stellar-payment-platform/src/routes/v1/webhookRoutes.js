const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../../../prismaClient');
const { poolRun, poolAll } = require('../../db');
const { logger } = require('../../logger');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { shouldFallbackToLocalRegistry } = require('../../utils');
const { idempotencyMiddleware } = require('../../../middleware/idempotency');
const { authenticateUsernameOwner } = require('../../services/ownershipService');
const { ACTIVITY_ACTIONS, recordActivity } = require('../../services/activityService');

module.exports = (redisClient) => {
  const router = express.Router();

  // ── Idempotency protection for mutating webhook routes (POST /webhooks and
  // DELETE /webhooks/:id). Duplicate requests within 24h return the cached
  // 2xx response. Read-only GET /webhooks is ignored. ────────────────────────
  router.use(idempotencyMiddleware(redisClient));

const normalizeWebhookEvents = (events) => {
  if (Array.isArray(events)) return events;
  if (typeof events === 'string') {
    try {
      const parsed = JSON.parse(events || '[]');
      return Array.isArray(parsed) ? parsed : ['*'];
    } catch {
      return ['*'];
    }
  }
  return ['*'];
};

const DEFAULT_FEDERATION_DOMAIN = 'localhost';

const authenticateWebhookCall = (req) =>
  authenticateUsernameOwner({
    username: req.body?.username,
    signature: req.body?.signature,
    signerAddress: req.body?.signerAddress,
    operation: typeof req.body?.operation === 'string' ? req.body.operation : 'webhook',
  });

const isValidWebhookUrl = (url) => {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};


/**
 * @openapi
 * /webhooks:
 *   post:
 *     tags:
 *       - v1
 *     description: POST /webhooks
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/webhooks', asyncHandler(async (req, res, next) => {
  try {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Unsupported Media Type. Please send application/json' });
    }

    const user = await authenticateWebhookCall(req);
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const events = normalizeWebhookEvents(req.body?.events);

    if (!isValidWebhookUrl(rawUrl)) {
      return res.status(400).json({ error: 'Invalid webhook URL. Must be http or https.' });
    }

    const secret = crypto.randomBytes(32).toString('hex');
    const id = uuidv4();
    const now = new Date();

    let webhook;
    try {
      webhook = await prisma.webhook.create({
        data: {
          id,
          username: user.username,
          url: rawUrl,
          secret,
          events,
          createdAt: now,
        },
      });
    } catch (error) {
      if (
        error?.code === 'P2002' &&
        Array.isArray(error.meta?.target) &&
        error.meta.target.includes('username') &&
        error.meta.target.includes('url')
      ) {
        const conflictError = new Error('A webhook with this URL is already registered for the user.');
        conflictError.statusCode = 409;
        return next(conflictError);
      }
      if (!shouldFallbackToLocalRegistry(error)) throw error;

      await poolRun(
        `INSERT INTO webhooks (id, username, url, secret, events, created_at, last_sent_at, failing_since)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)`,
        [id, user.username, rawUrl, secret, JSON.stringify(events), now.toISOString()],
      );
      webhook = { id, username: user.username, url: rawUrl, events, createdAt: now.toISOString() };
    }

    await recordActivity(prisma, {
      username: user.username,
      action: ACTIVITY_ACTIONS.WEBHOOK_CREATED,
      metadata: { webhook_id: webhook.id, url: rawUrl, events },
      req,
    });

    return res.status(201).json({
      ok: true,
      webhook: {
        id: webhook.id,
        username: webhook.username,
        url: webhook.url,
        events: Array.isArray(webhook.events) ? webhook.events : normalizeWebhookEvents(webhook.events),
        secret,
        created_at: (webhook.createdAt instanceof Date
          ? webhook.createdAt
          : new Date(webhook.createdAt)
        ).toISOString(),
      },
      note: 'Save the secret securely — it will only be returned once. Signatures for webhook payloads are computed with HMAC-SHA256 using this secret.',
    });
  } catch (err) {
    if (err.statusCode) return next(err);
    logger.error('[webhooks] POST /webhooks failed:', err.message);
    const generic = new Error('Failed to register webhook');
    generic.statusCode = 500;
    return next(generic);
  }
}));


/**
 * @openapi
 * /webhooks:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /webhooks
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/webhooks', asyncHandler(async (req, res, next) => {
  try {
    if (!req.is('application/json') && Object.keys(req.body || {}).length > 0) {
      return res.status(415).json({ error: 'Unsupported Media Type. Please send application/json' });
    }

    const user = await authenticateWebhookCall(req);

    let webhooks;
    try {
      webhooks = await prisma.webhook.findMany({
        where: { username: user.username },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      if (!shouldFallbackToLocalRegistry(error)) throw error;
      const rows = await poolAll(
        `SELECT id, username, url, events, created_at, last_sent_at, failing_since
         FROM webhooks WHERE username = $1 ORDER BY created_at DESC`,
        [user.username],
      );
      webhooks = rows.map((r) => ({
        id: r.id,
        username: r.username,
        url: r.url,
        events: Array.isArray(r.events) ? r.events : (typeof r.events === 'string' ? JSON.parse(r.events || '[]') : ['*']),
        createdAt: r.created_at,
        lastSentAt: r.last_sent_at,
        failingSince: r.failing_since,
      }));
    }

    return res.status(200).json({
      ok: true,
      webhooks: webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        events: Array.isArray(w.events) ? w.events : normalizeWebhookEvents(w.events),
        created_at: (w.createdAt instanceof Date ? w.createdAt : new Date(w.createdAt)).toISOString(),
        last_sent_at: w.lastSentAt
          ? (w.lastSentAt instanceof Date ? w.lastSentAt : new Date(w.lastSentAt)).toISOString()
          : null,
        failing_since: w.failingSince
          ? (w.failingSince instanceof Date ? w.failingSince : new Date(w.failingSince)).toISOString()
          : null,
      })),
    });
  } catch (err) {
    if (err.statusCode) return next(err);
    logger.error('[webhooks] GET /webhooks failed:', err.message);
    const generic = new Error('Failed to list webhooks');
    generic.statusCode = 500;
    return next(generic);
  }
}));


/**
 * @openapi
 * /webhooks/:id:
 *   delete:
 *     tags:
 *       - v1
 *     description: DELETE /webhooks/:id
 *     responses:
 *       200:
 *         description: Success
 */
router.delete('/webhooks/:id', asyncHandler(async (req, res, next) => {
  try {
    if (!req.is('application/json') && Object.keys(req.body || {}).length > 0) {
      return res.status(415).json({ error: 'Unsupported Media Type. Please send application/json' });
    }

    const user = await authenticateWebhookCall(req);
    const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';

    if (!id) {
      return res.status(400).json({ error: 'Webhook id is required in URL path.' });
    }

    let deletedCount = 0;
    try {
      const deleted = await prisma.webhook.deleteMany({
        where: { id, username: user.username },
      });
      deletedCount = deleted.count;
    } catch (error) {
      if (!shouldFallbackToLocalRegistry(error)) throw error;
      const result = await poolRun(
        'DELETE FROM webhooks WHERE id = $1 AND username = $2',
        [id, user.username],
      );
      deletedCount = result?.changes || 0;
    }

    if (deletedCount === 0) {
      return res.status(404).json({ error: 'Webhook not found.' });
    }

    await recordActivity(prisma, {
      username: user.username,
      action: ACTIVITY_ACTIONS.WEBHOOK_DELETED,
      metadata: { webhook_id: id },
      req,
    });

    return res.status(200).json({ ok: true, deleted: true });
  } catch (err) {
    if (err.statusCode) return next(err);
    logger.error('[webhooks] DELETE /webhooks/:id failed:', err.message);
    const generic = new Error('Failed to delete webhook');
    generic.statusCode = 500;
    return next(generic);
  }
}));

  router.post('/webhooks/verify-test', (req, res) => {
    const { secret, payload } = req.body;
    const signature = req.headers['x-webhook-signature'];

    if (!secret || !payload) {
      return res.status(400).json({ error: 'Missing secret or payload' });
    }

    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    if (signature === expectedSignature) {
      return res.status(200).json({
        ok: true,
        valid: true,
        message: 'Signature verification succeeded',
        expectedSignature,
      });
    } else {
      return res.status(401).json({
        ok: false,
        valid: false,
        error: { code: 'INVALID_WEBHOOK_SIGNATURE' },
        receivedSignature: signature,
      });
    }
  });

  router.all('/webhooks', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    res.status(404).end();
  });

  return router;
};

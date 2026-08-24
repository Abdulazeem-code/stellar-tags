const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { invalidateFederationCache } = require('../../cache');
const { listDLQEntries, replayFromDLQ } = require('../../webhookWorker');

module.exports = (redisClient) => {
  const router = express.Router();

  const getPrisma = () => require('../../../prismaClient').prisma;

  const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
    }
    next();
  };

  // ── Block address ──────────────────────────────────────────────────────

  router.post(
    '/admin/block',
    adminAuth,
    asyncHandler(async (req, res, next) => {
      const prisma = getPrisma();
      const { address } = req.body;

      if (!address || typeof address !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid address' });
      }

      try {
        const updatedUser = await prisma.user.update({
          where: { address },
          data: { flaggedAt: new Date() },
        });

        invalidateFederationCache(updatedUser.username, updatedUser.address);

        return res.status(200).json({
          message: 'Address successfully blocked',
          username: updatedUser.username,
          address: updatedUser.address,
          flaggedAt: updatedUser.flaggedAt,
        });
      } catch (error) {
        if (error.code === 'P2025') {
          return res.status(404).json({ error: 'Address not found' });
        }
        return next(error);
      }
    }),
  );

  // ── Dead Letter Queue (DLQ) ────────────────────────────────────────────

  /**
   * GET /admin/dlq
   * List dead-letter-queue entries.  Supports optional `?username=` filter,
   * `?limit=` (default 50, max 200), and `?offset=` (default 0).
   */
  router.get(
    '/admin/dlq',
    adminAuth,
    asyncHandler(async (req, res, next) => {
      const prisma = getPrisma();
      const username =
        typeof req.query.username === 'string'
          ? req.query.username.trim()
          : undefined;
      const limit = Math.min(
        Math.max(parseInt(req.query.limit, 10) || 50, 1),
        200,
      );
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      try {
        const { entries, total } = await listDLQEntries(
          prisma,
          async (sql, params) => {
            // Fallback path not used in normal operation; provide empty impl
            return [];
          },
          { username, limit, offset },
        );

        return res.status(200).json({
          ok: true,
          total,
          limit,
          offset,
          entries: entries.map((e) => ({
            id: e.id,
            webhook_id: e.webhookId,
            webhook_url: e.webhookUrl,
            username: e.username,
            event_type: e.eventType,
            failure_reason: e.failureReason,
            delivery_attempts: e.deliveryAttempts,
            moved_at: (e.movedAt instanceof Date
              ? e.movedAt
              : new Date(e.movedAt)
            ).toISOString(),
            replayed: e.replayed,
            replayed_at: e.replayedAt
              ? (e.replayedAt instanceof Date
                  ? e.replayedAt
                  : new Date(e.replayedAt)
                ).toISOString()
              : null,
          })),
        });
      } catch (error) {
        return next(error);
      }
    }),
  );

  /**
   * POST /admin/dlq/:id/replay
   * Manually replay a dead-letter-queue entry — retries delivery once.
   */
  router.post(
    '/admin/dlq/:id/replay',
    adminAuth,
    asyncHandler(async (req, res, next) => {
      const prisma = getPrisma();
      const id =
        typeof req.params?.id === 'string' ? req.params.id.trim() : '';

      if (!id) {
        return res.status(400).json({ error: 'DLQ entry id is required in URL path.' });
      }

      try {
        const result = await replayFromDLQ(prisma, async (sql, params) => [], id);

        if (!result.ok) {
          const status = result.error === 'DLQ entry not found' ? 404 : 409;
          return res.status(status).json({ error: result.error });
        }

        return res.status(200).json({ ok: true, replayed: true });
      } catch (error) {
        return next(error);
      }
    }),
  );

  return router;
};
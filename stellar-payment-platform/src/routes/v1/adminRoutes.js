'use strict';

/**
 * src/routes/v1/adminRoutes.js
 *
 * Admin-only endpoints.  All routes require the ADMIN_API_KEY header or
 * query parameter.
 *
 * Routes
 *  POST /admin/block          – flag (soft-block) an address
 *  GET  /admin/export         – stream transaction records as CSV or JSON
 *  GET  /admin/stats/routing  – fetch historical payment routing statistics
 */
const express = require('express');
const { invalidateFederationCache } = require('../../federationCache');
const { invalidateStatsCache } = require('../../cache/statsCache');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { validateSchema } = require('../../middleware/validateSchema');
const {
  adminBlockBodySchema,
  adminExportQuerySchema,
  adminRoutingStatsQuerySchema,
} = require('../../schemas');
const { streamAdminExport } = require('../../utils/exporter');
const { getRoutingStats } = require('../../services/statsService');
const { auditLogMiddleware } = require('../../middleware/auditLog');
const { idempotencyMiddleware } = require('../../../middleware/idempotency');
const { logger } = require('../../logger');
const {
  parsePagination,
  paginatedResponse,
  parseCursorQuery,
  paginateByKeyset,
  cursorPaginatedResponse,
  keysetWhereDesc
} = require('../../pagination');
const { listDLQEntries, replayFromDLQ } = require('../../webhookWorker');
const { ACTIVITY_ACTIONS, recordActivity } = require('../../services/activityService');
const { PRIMARY_USERNAME_ORDER } = require('../../utils');

// PAGE_SIZE for the admin export cursor-based pagination
const EXPORT_PAGE_SIZE = 500;

module.exports = (redisClient) => {

  const router = express.Router();

  // ── Intercept mutating admin requests for audit logging ───────────────────
  router.use(auditLogMiddleware);

  // ── Idempotency protection for all mutating admin routes (POST/PUT/DELETE).
  // GET endpoints (export, audit-logs) are ignored by the middleware. ────────
  router.use(idempotencyMiddleware(redisClient));

  const getPrisma = () => {
    return require('../../../prismaClient');
  };

  const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
    }
    next();
  };

  // ── GET /admin/export ──────────────────────────────────────────────────────
  // Streams all payment records as CSV (default) or NDJSON.
  // Supports optional startDate / endDate query params for filtering.
  // Paginates internally using cursor-based pages so memory stays bounded.
  
/**
 * @openapi
 * /admin/export:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /admin/export
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/admin/export', adminAuth, asyncHandler(async (req, res, next) => {
    const { format = 'csv', startDate, endDate } = req.query;

    // Validate date range when provided
    let dateFilter;
    if (startDate || endDate) {
      const gte = startDate ? new Date(startDate) : undefined;
      const lte = endDate ? new Date(endDate) : undefined;

      if (gte && isNaN(gte.getTime())) {
        return res.status(400).json({ error: 'Invalid startDate' });
      }
      if (lte && isNaN(lte.getTime())) {
        return res.status(400).json({ error: 'Invalid endDate' });
      }
      if (gte && lte && gte > lte) {
        return res.status(400).json({ error: 'startDate must not be after endDate' });
      }
      dateFilter = {};
      if (gte) dateFilter.gte = gte;
      if (lte) dateFilter.lte = lte;
    }

    const isJson = format === 'json';
    const contentType = isJson ? 'application/x-ndjson' : 'text/csv; charset=utf-8';
    const ext = isJson ? 'ndjson' : 'csv';
    const filename = `admin-export-${new Date().toISOString().slice(0, 10)}.${ext}`;

    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    const { prisma } = getPrisma();
    let skip = 0;
    let headerWritten = false;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const where = dateFilter ? { createdAt: dateFilter } : {};
        const records = await prisma.payment.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          skip,
          take: EXPORT_PAGE_SIZE,
        });

        if (records.length === 0) break;

        for (const record of records) {
          if (isJson) {
            res.write(JSON.stringify(record) + '\n');
          } else {
            // CSV: write header row on first record
            if (!headerWritten) {
              const headers = Object.keys(record);
              res.write(headers.map((h) => `"${h}"`).join(',') + '\n');
              headerWritten = true;
            }
            const values = Object.values(record).map((v) => {
              if (v === null || v === undefined) return '';
              const s = String(v instanceof Date ? v.toISOString() : v);
              return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"`
                : s;
            });
            res.write(values.join(',') + '\n');
          }
        }

        if (records.length < EXPORT_PAGE_SIZE) break;
        skip += EXPORT_PAGE_SIZE;
      }

      return res.end();
    } catch (err) {
      logger.error(`[Correlation ID: ${req.correlationId}] Admin export failed`, err);
      return res.destroy(err);
    }
  }));

  
/**
 * @openapi
 * /admin/block:
 *   post:
 *     tags:
 *       - v1
 *     description: POST /admin/block
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/admin/block', adminAuth, asyncHandler(async (req, res, next) => {
    const { prisma, withTransaction } = getPrisma();
    const { address } = req.body;

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid address' });
    }

    try {
      // #613 dropped the unique index on address, so a single `update` keyed on
      // it no longer resolves. An address can now carry several usernames and
      // blocking it has to flag every one of them.
      const flaggedAt = new Date();
      const { count } = await prisma.user.updateMany({
        where: { address, deletedAt: null },
        data: { flaggedAt },
      });

      if (count === 0) {
        return res.status(404).json({ error: 'Address not found' });
      }

      const blocked = await prisma.user.findMany({
        where: { address, deletedAt: null },
        orderBy: PRIMARY_USERNAME_ORDER,
        select: { username: true },
      });
      const usernames = blocked.map((user) => user.username);

      for (const username of usernames) {
        await invalidateFederationCache(redisClient, address, username);
        await recordActivity(prisma, {
          username,
          action: ACTIVITY_ACTIONS.USER_BLOCKED,
          metadata: { address },
          req,
        });
      }
      await invalidateStatsCache(redisClient);

      return res.status(200).json({
        message: 'Address successfully blocked',
        username: usernames[0],
        usernames,
        address,
        flaggedAt,
      });
    } catch (error) {
      return next(error);
    }
  }));

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

  // ── GET /admin/stats/routing ─────────────────────────────────────────────

  /**
   * Returns historical payment routing aggregation statistics (volume, fees, counts)
   * grouped by day, week, or month with optional date-range and asset filtering.
   *
   * Query parameters:
   *  - startDate (optional) YYYY-MM-DD inclusive lower bound on createdAt
   *  - endDate   (optional) YYYY-MM-DD inclusive upper bound on createdAt
   *  - groupBy   (optional) 'day' (default) | 'week' | 'month'
   *  - interval  (optional) alias for groupBy
   *  - assetCode (optional) filter by asset code
   */
  router.get(
    '/admin/stats/routing',
    adminAuth,
    validateSchema({ query: adminRoutingStatsQuerySchema }),
    asyncHandler(async (req, res) => {
      const { startDate, endDate, groupBy, interval, assetCode } = req.query;
      const prisma = getPrisma();

      const stats = await getRoutingStats({
        prisma,
        startDate,
        endDate,
        groupBy: interval || groupBy || 'day',
        assetCode,
      });

      return res.status(200).json({
        success: true,
        ...stats,
      });
    }),
  );

  // ── GET /admin/users/blocked ─────────────────────────────────────────────
  router.get('/admin/users/blocked', adminAuth, asyncHandler(async (req, res, next) => {
    const prisma = getPrisma();
    const { search, cursor, page } = req.query;

    const where = {
      flaggedAt: { not: null }
    };

    if (search) {
      where.OR = [
        { username: { contains: search } },
        { address: { contains: search } }
      ];
    }

    if (cursor !== undefined || (page === undefined && cursor === undefined)) {
      // Keyset (cursor) pagination
      const { limit, cursor: parsedCursor, invalid } = parseCursorQuery(req.query);
      if (invalid) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }

      if (parsedCursor) {
        where.AND = [keysetWhereDesc(parsedCursor)];
      }

      const users = await prisma.user.findMany({
        where,
        take: limit + 1,
        orderBy: [
          { createdAt: 'desc' },
          { username: 'desc' },
        ],
        select: {
          username: true,
          address: true,
          flaggedAt: true,
          createdAt: true
        }
      });

      const { rows, hasMore, nextCursor } = paginateByKeyset(users, limit);
      return res.status(200).json(cursorPaginatedResponse(rows, { limit, nextCursor, hasMore }));
    } else {
      // Offset pagination
      const { page: parsedPage, limit, skip } = parsePagination(req.query);
      
      const [totalCount, users] = await prisma.$transaction([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            username: true,
            address: true,
            flaggedAt: true,
            createdAt: true
          }
        })
      ]);
      
      return res.status(200).json(paginatedResponse(users, totalCount, { page: parsedPage, limit }));
    }
  }));

  // ── GET /admin/audit-logs ────────────────────────────────────────────────

  /**
   * Retrieves recent admin audit logs.
   *
   * Query parameters:
   *  - limit (optional) integer between 1 and 100, default 50
   */
  
/**
 * @openapi
 * /admin/audit-logs:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /admin/audit-logs
 *     responses:
 *       200:
 *         description: Success
 */
router.get(
    '/admin/audit-logs',
    adminAuth,
    asyncHandler(async (req, res) => {
      const { prisma } = getPrisma();
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const logs = await prisma.auditLog.findMany({
        take: limit,
        orderBy: { createdAt: 'desc' },
      });

      return res.status(200).json({
        success: true,
        count: logs.length,
        data: logs,
      });
    }),
  );

  return router;
};

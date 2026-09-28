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
  adminDlqQuerySchema,
  adminDlqReplayBodySchema,
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
  keysetWhereDesc,
  keysetWhereAscById
} = require('../../pagination');
const {
  listDlqMessages,
  getDlqMessage,
  replayDlqMessage,
  replayDlqMessages,
  discardDlqMessage,
} = require('../../dlq');
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
    // Keyset walk (issue #677): pages seek strictly past the last row's
    // (createdAt, id) tuple instead of skipping OFFSET rows, so deep pages
    // cost the same as the first. The id tie-breaker also guarantees stable
    // ordering when rows share a timestamp.
    let cursor = null;
    let headerWritten = false;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const baseWhere = dateFilter ? { createdAt: dateFilter } : {};
        const where = cursor
          ? { AND: [baseWhere, keysetWhereAscById(cursor)] }
          : baseWhere;
        const records = await prisma.payment.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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

        const last = records[records.length - 1];
        cursor = { createdAt: last.createdAt, id: last.id };
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
  //
  // Payment retry jobs that exhausted their attempts are parked in a dedicated
  // BullMQ queue so an operator can inspect and replay them. The routes below
  // sit inside the router-level auditLogMiddleware, so every mutating call
  // (replay, bulk replay, discard) is recorded with its body redacted.

  /**
   * GET /admin/dlq
   * One page of dead-letter-queue messages, newest first.
   *
   * Query parameters:
   *  - limit    (optional) page size, clamped to 1-100 (default 20)
   *  - page     (optional) 1-based page number (default 1)
   *  - username (optional) narrow the listing to one merchant
   *
   * Payloads are redacted with the same helper the audit log uses, so a
   * merchant secret never leaves the process through this route.
   */
  router.get(
    '/admin/dlq',
    adminAuth,
    validateSchema({ query: adminDlqQuerySchema }),
    asyncHandler(async (req, res) => {
      const { limit, page, username } = req.query;
      const { available, messages, total } = await listDlqMessages({ limit, page, username });

      return res.status(200).json({
        success: true,
        available,
        messages,
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    }),
  );

  /**
   * GET /admin/dlq/:id
   * A single dead-letter-queue message, payload redacted.
   */
  router.get(
    '/admin/dlq/:id',
    adminAuth,
    asyncHandler(async (req, res) => {
      return res.status(200).json({ success: true, message: await getDlqMessage(req.params.id) });
    }),
  );

  /**
   * POST /admin/dlq/:id/replay
   * Re-enqueue one message onto the main queue it came from with a fresh
   * attempt budget, then drop it from the DLQ.
   */
  router.post(
    '/admin/dlq/:id/replay',
    adminAuth,
    asyncHandler(async (req, res) => {
      const result = await replayDlqMessage(req.params.id);
      return res.status(200).json({ success: true, replayed: true, ...result });
    }),
  );

  /**
   * POST /admin/dlq/replay
   * Replay a batch of messages, optionally narrowed to one merchant. The batch
   * size is capped so a single request cannot flood the main queue.
   */
  router.post(
    '/admin/dlq/replay',
    adminAuth,
    validateSchema({ body: adminDlqReplayBodySchema }),
    asyncHandler(async (req, res) => {
      const { limit, username } = req.body;
      const result = await replayDlqMessages({ limit, username });

      return res.status(200).json({
        success: true,
        replayed: result.replayed.length,
        failed: result.failed,
        capped: result.capped,
      });
    }),
  );

  /**
   * DELETE /admin/dlq/:id
   * Permanently drop one message without replaying it.
   */
  router.delete(
    '/admin/dlq/:id',
    adminAuth,
    asyncHandler(async (req, res) => {
      return res.status(200).json({ success: true, ...(await discardDlqMessage(req.params.id)) });
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
      const { prisma } = getPrisma();

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
    const { prisma } = getPrisma();
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

  // ── GET /admin/webhooks/health ───────────────────────────────────────────
  // Aggregates webhook delivery health so ops can spot broken merchant
  // integrations: total/healthy/failing counts, a rolling 24h success rate,
  // and the URLs that have been failing for more than 24h.
  router.get('/admin/webhooks/health', adminAuth, asyncHandler(async (req, res) => {
    const { prisma } = getPrisma();
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    const where = username ? { username } : {};
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [total, failing, activeLast24h, failingLast24h, failingOver24h] = await Promise.all([
      prisma.webhook.count({ where }),
      prisma.webhook.count({ where: { ...where, failingSince: { not: null } } }),
      prisma.webhook.count({ where: { ...where, lastSentAt: { gte: dayAgo } } }),
      prisma.webhook.count({ where: { ...where, lastSentAt: { gte: dayAgo }, failingSince: { not: null } } }),
      prisma.webhook.findMany({
        where: { ...where, failingSince: { lte: dayAgo } },
        select: { id: true, username: true, url: true, failingSince: true },
        orderBy: { failingSince: 'asc' },
      }),
    ]);

    return res.status(200).json({
      success: true,
      summary: {
        total,
        healthy: total - failing,
        failing,
        successRate24h: activeLast24h
          ? Number((((activeLast24h - failingLast24h) / activeLast24h) * 100).toFixed(2))
          : null,
      },
      failingOver24h,
    });
  }));

  return router;
};

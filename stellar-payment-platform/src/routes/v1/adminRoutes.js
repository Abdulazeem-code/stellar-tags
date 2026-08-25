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
 *  GET  /admin/audit-logs     – retrieve recent admin audit logs
 */

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { validateSchema } = require('../../middleware/validateSchema');
const { auditLogMiddleware } = require('../../middleware/auditLog');
const { adminBlockBodySchema, adminExportQuerySchema } = require('../../schemas');
const { streamAdminExport } = require('../../utils/exporter');
const { invalidateFederationCache } = require('../../cache');
const { logger } = require('../../logger');

module.exports = (redisClient) => {
  const router = express.Router();

  // ── Intercept mutating admin requests for audit logging ───────────────────
  router.use(auditLogMiddleware);

  // ── Admin authentication middleware ──────────────────────────────────────


  const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
    }
    return next();
  };

  // ── Helpers ──────────────────────────────────────────────────────────────

  const getPrisma = () => require('../../../prismaClient').prisma;

  // ── POST /admin/block ────────────────────────────────────────────────────

  /**
   * Flags (soft-blocks) a registered address so it cannot be served from the
   * federation cache and can be detected by downstream logic.
   *
   * Body: { address: string }
   */
  router.post(
    '/admin/block',
    adminAuth,
    validateSchema({ body: adminBlockBodySchema }),
    asyncHandler(async (req, res, next) => {
      const prisma = getPrisma();
      const { address } = req.body;

      try {
        const updatedUser = await prisma.user.update({
          where: { address },
          data: { flaggedAt: new Date() },
        });

        // Evict federation cache so the blocked user is no longer served stale.
        await invalidateFederationCache(redisClient, updatedUser.address, updatedUser.username);

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

  // ── GET /admin/export ────────────────────────────────────────────────────

  /**
   * Streams all transaction records from the database to the HTTP response.
   *
   * Query parameters:
   *  - format    (optional) 'csv' (default) | 'json'
   *  - startDate (optional) YYYY-MM-DD inclusive lower bound on createdAt
   *  - endDate   (optional) YYYY-MM-DD inclusive upper bound on createdAt
   *
   * The response is committed before streaming begins, so a mid-stream failure
   * can only be logged and the connection cut — the JSON error envelope needs
   * unsent headers.
   */
  router.get(
    '/admin/export',
    adminAuth,
    validateSchema({ query: adminExportQuerySchema }),
    asyncHandler(async (req, res, next) => {
      const { format, startDate, endDate } = req.query;
      const prisma = getPrisma();

      try {
        await streamAdminExport({
          res,
          prisma,
          format,
          startDate,
          endDate,
          logger,
          correlationId: req.correlationId || 'unknown',
        });
      } catch (err) {
        // If headers have not been sent yet we can still return a JSON error.
        if (!res.headersSent) {
          return next(err);
        }
        // Headers already sent — stream is committed, can only destroy.
        logger.error(
          `[admin-export][${req.correlationId}] Stream failed after headers sent:`,
          err.message,
        );
        return res.destroy(err);
      }
    }),
  );

  // ── GET /admin/audit-logs ────────────────────────────────────────────────

  /**
   * Retrieves recent admin audit logs.
   *
   * Query parameters:
   *  - limit (optional) integer between 1 and 100, default 50
   */
  router.get(
    '/admin/audit-logs',
    adminAuth,
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
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


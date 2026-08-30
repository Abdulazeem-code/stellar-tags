'use strict';

const express = require('express');
const { invalidateFederationCache } = require('../../federationCache');
const { invalidateStatsCache } = require('../../cache/statsCache');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { auditLogMiddleware } = require('../../middleware/auditLog');
const { logger } = require('../../logger');

// PAGE_SIZE for the admin export cursor-based pagination
const EXPORT_PAGE_SIZE = 500;

module.exports = (redisClient) => {
  const router = express.Router();

  // ── Intercept mutating admin requests for audit logging ───────────────────
  router.use(auditLogMiddleware);

  const getPrisma = () => {
    return require('../../../prismaClient').prisma;
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

    const prisma = getPrisma();
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

  router.post('/admin/block', adminAuth, asyncHandler(async (req, res, next) => {
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

      await invalidateFederationCache(redisClient, updatedUser.address, updatedUser.username);
      await invalidateStatsCache(redisClient);

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
  }));

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


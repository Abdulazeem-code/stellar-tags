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

      // Evict federation cache so blocked users are not served from cache
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


const express = require('express');
const { prisma } = require('../../../prismaClient');
const { poolGet } = require('../../db');
const { logger } = require('../../logger');
const { asyncHandler } = require('../../middleware/asyncHandler');

const router = express.Router();

const SERVER_START_TIME = Date.now();

const shouldFallbackToLocalRegistry = (error) => {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';

  return (
    code.startsWith('P10') ||
    ['P2021', 'P2023', 'P2028', 'P2001'].includes(code) ||
    /DATABASE_URL|connect|relation|table|timeout/i.test(message)
  );
};

router.get('/stats', asyncHandler(async (req, res, next) => {
  try {
    let totalRegisteredUsers;
    let activeTokens;

    try {
      [totalRegisteredUsers, activeTokens] = await prisma.$transaction([
        prisma.user.count(),
        prisma.user.count({ where: { flaggedAt: null } }),
      ]);
    } catch (error) {
      if (!shouldFallbackToLocalRegistry(error)) {
        throw error;
      }

      const totalCountRow = await poolGet(
        'SELECT COUNT(*) AS "totalCount" FROM username_registry',
      );
      const activeCountRow = await poolGet(
        'SELECT COUNT(*) AS "activeCount" FROM username_registry WHERE flagged_at IS NULL',
      );
      totalRegisteredUsers = Number(totalCountRow?.totalCount || 0);
      activeTokens = Number(activeCountRow?.activeCount || 0);
    }

    const uptimeSeconds = Math.floor(process.uptime());
    const uptimeStartTimestamp = SERVER_START_TIME;

    return res.status(200).json({
      total_registered_users: totalRegisteredUsers,
      active_tokens: activeTokens,
      platform_uptime_seconds: uptimeSeconds,
      platform_uptime_started_at: new Date(uptimeStartTimestamp).toISOString(),
    });
  } catch (error) {
    logger.error(`[Correlation ID: ${req.correlationId}] Stats endpoint error`, error);
    const statsError = new Error('Failed to retrieve platform statistics', { cause: error });
    statsError.statusCode = 500;
    return next(statsError);
  }
}));

module.exports = router;

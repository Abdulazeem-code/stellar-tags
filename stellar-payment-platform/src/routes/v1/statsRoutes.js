'use strict';

const express = require('express');
const { prisma } = require('../../../prismaClient');
const { poolGet, etagCache } = require('../../db');
const { logger } = require('../../logger');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { getCachedStats } = require('../../cache/statsCache');
const { fetchAdminStats } = require('../../services/statsService');

module.exports = (redisClient) => {
  const router = express.Router();

  
/**
 * @openapi
 * /stats:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /stats
 *     responses:
 *       200:
 *         description: Success
 */
  router.get('/stats', etagCache, asyncHandler(async (req, res, next) => {
    try {
      const stats = await getCachedStats(redisClient, () => fetchAdminStats(prisma, poolGet));
      return res.status(200).json(stats);
    } catch (error) {
      logger.error(`[Correlation ID: ${req.correlationId}] Stats endpoint error`, error);
      const statsError = new Error('Failed to retrieve platform statistics', { cause: error });
      statsError.statusCode = 500;
      return next(statsError);
    }
  }));

  return router;
};

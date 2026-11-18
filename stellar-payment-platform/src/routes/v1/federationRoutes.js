const express = require('express');
const db = require('../../db');
const normalizeNameTag = db.normalizeNameTag || ((v) => v);
const etagCache = db.etagCache || ((_req, _res, next) => next());
const {
  federationNameKey,
  federationIdKey,
  federationLookupCached,
} = require('../../cache');
const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { federationQuerySchema } = require('../../schemas');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { resolveFederationId, resolveFederationName } = require('../../services/federationService');
const { createTokenBucketLimiter } = require('../../middleware/tokenBucketLimiter');

module.exports = (redisClient) => {
  const router = express.Router();

  const ipLimiter = createTokenBucketLimiter(redisClient, {
    capacity: 100,
    refillRate: 100 / (15 * 60),
    prefix: 'ip-rl:',
    keyGenerator: (req) =>
      req.ip || (req.connection && req.connection.remoteAddress) || '',
  });

/**
 * @openapi
 * /federation:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /federation
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/federation', ipLimiter, etagCache, validateSchema({ query: federationQuerySchema }), asyncHandler(async (req, res, next) => {
    const { q: queryValue, type } = req.query;

    try {
      if (type === 'id') {
        const cacheKey = federationIdKey(queryValue);
        const cached = await federationLookupCached(cacheKey, async () => {
          return await resolveFederationId(queryValue);
        });

        if (!cached) {
          const notFoundError = new Error('Address not found');
          notFoundError.statusCode = 404;
          return next(notFoundError);
        }

        return res.json(cached);
      } else if (type === 'name' || !type) {
        const nameTag = normalizeNameTag(queryValue);
        const queryName = nameTag.toLowerCase();
        const cacheKey = federationNameKey(queryName);

        const cached = await federationLookupCached(cacheKey, async () => {
          return await resolveFederationName(queryName);
        });

        if (!cached) {
          const notFoundError = new Error('Name tag not found');
          notFoundError.statusCode = 404;
          return next(notFoundError);
        }

        return res.json(cached);
      } else {
        return next(
          new ApiError('INVALID_INPUT', "Unsupported query type. Supported types: 'id', 'name'"),
        );
      }
    } catch (error) {
      if (error.statusCode === 403) {
        return next(error);
      }
      const dbError = new Error('Database lookup failed', { cause: error });
      dbError.statusCode = 500;
      return next(dbError);
    }
  }));

  return router;
};

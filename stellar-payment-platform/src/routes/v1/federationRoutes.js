const express = require('express');
const { prisma } = require('../../../prismaClient');
const { normalizeNameTag, etagCache, USER_DATABASE } = require('../../db');
const {
  federationNameKey,
  federationIdKey,
  federationLookupCached,
} = require('../../cache');
const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { federationQuerySchema } = require('../../schemas');

module.exports = (redisClient) => {
  const router = express.Router();

  router.get('/federation', etagCache, validateSchema({ query: federationQuerySchema }), async (req, res, next) => {
    const { q: queryValue, type } = req.query;

    try {
      if (type === 'id') {
        const cacheKey = federationIdKey(queryValue);
        const cached = await federationLookupCached(cacheKey, async () => {
          const row = await prisma.user.findFirst({
            where: { address: { equals: queryValue, mode: 'insensitive' }, deletedAt: null },
            select: { username: true, address: true, memoType: true, memo: true },
          });

          if (!row) return null;

          const response = {
            stellar_address: `${row.username}*${process.env.DOMAIN || 'localhost'}`,
            account_id: row.address,
          };
          if (row.memoType) {
            response.memo_type = row.memoType;
            response.memo = row.memo;
          }
          return response;
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
          const row = await prisma.user.findFirst({
            where: { username: queryName, deletedAt: null },
            select: { address: true, memoType: true, memo: true },
          });

          const address = row?.address || USER_DATABASE[queryName];
          if (!address) return null;

          const response = {
            stellar_address: address,
            account_id: address,
          };
          if (row?.memoType) {
            response.memo_type = row.memoType;
            response.memo = row.memo;
          }
          return response;
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
      const dbError = new Error('Database lookup failed', { cause: error });
      dbError.statusCode = 500;
      return next(dbError);
    }
  });

  return router;
};

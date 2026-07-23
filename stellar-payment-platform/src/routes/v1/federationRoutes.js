const express = require('express');
const { prisma } = require('../../../prismaClient');
const { normalizeNameTag, etagCache, USER_DATABASE } = require('../../db');

const router = express.Router();

router.get('/federation', etagCache, async (req, res, next) => {
  const { q, type } = req.query;
  const queryValue = typeof q === 'string' ? q.trim() : '';

  if (!queryValue) {
    const error = new Error("Missing 'q' parameter");
    error.statusCode = 400;
    return next(error);
  }

  try {
    if (type === 'id') {
      const row = await prisma.user.findFirst({
        where: { address: { equals: queryValue, mode: 'insensitive' }, deletedAt: null },
        select: { username: true, address: true, memoType: true, memo: true },
      });

      if (!row) {
        const notFoundError = new Error('Address not found');
        notFoundError.statusCode = 404;
        return next(notFoundError);
      }

      const response = {
        stellar_address: `${row.username}*${process.env.DOMAIN || 'localhost'}`,
        account_id: row.address,
      };
      if (row.memoType) {
        response.memo_type = row.memoType;
        response.memo = row.memo;
      }
      return res.json(response);
    } else if (type === 'name' || !type) {
      const nameTag = normalizeNameTag(queryValue);
      const queryName = nameTag.toLowerCase();

      const row = await prisma.user.findFirst({
        where: { username: queryName, deletedAt: null },
        select: { address: true, memoType: true, memo: true },
      });

      const address = row?.address || USER_DATABASE[queryName];

      if (!address) {
        const notFoundError = new Error('Name tag not found');
        notFoundError.statusCode = 404;
        return next(notFoundError);
      }

      const response = {
        stellar_address: address,
        account_id: address,
      };
      if (row?.memoType) {
        response.memo_type = row.memoType;
        response.memo = row.memo;
      }
      return res.json(response);
    } else {
      return res.status(400).json({
        error: "Unsupported query type. Supported types: 'id', 'name'",
      });
    }
  } catch {
    const dbError = new Error('Database lookup failed');
    dbError.statusCode = 500;
    return next(dbError);
  }
});

module.exports = router;

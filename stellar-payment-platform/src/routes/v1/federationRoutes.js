const express = require('express');
const { prisma } = require('../../../prismaClient');
const { normalizeNameTag, etagCache, USER_DATABASE } = require('../../db');
const { success, fail, error: jsendError } = require('../../utils/jsend');

const router = express.Router();

router.get('/federation', etagCache, async (req, res, next) => {
  const { q, type } = req.query;
  const queryValue = typeof q === 'string' ? q.trim() : '';

  if (!queryValue) {
    return res.status(400).json(fail({ q: "Missing 'q' parameter" }));
  }

  try {
    if (type === 'id') {
      const row = await prisma.user.findFirst({
        where: { address: { equals: queryValue, mode: 'insensitive' } },
        select: { username: true, address: true, memoType: true, memo: true },
      });

      if (!row) {
        return res.status(404).json(fail({ address: 'Address not found' }));
      }

      const response = {
        stellar_address: `${row.username}*${process.env.DOMAIN || 'localhost'}`,
        account_id: row.address,
      };
      if (row.memoType) {
        response.memo_type = row.memoType;
        response.memo = row.memo;
      }
      return res.json(success(response));
    } else if (type === 'name' || !type) {
      const nameTag = normalizeNameTag(queryValue);
      const queryName = nameTag.toLowerCase();

      const row = await prisma.user.findUnique({
        where: { username: queryName },
        select: { address: true, memoType: true, memo: true },
      });

      const address = row?.address || USER_DATABASE[queryName];

      if (!address) {
        return res.status(404).json(fail({ name: 'Name tag not found' }));
      }

      const response = {
        stellar_address: address,
        account_id: address,
      };
      if (row?.memoType) {
        response.memo_type = row.memoType;
        response.memo = row.memo;
      }
      return res.json(success(response));
    } else {
      return res.status(400).json(fail({ type: "Unsupported query type. Supported types: 'id', 'name'" }));
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json(jsendError('Database lookup failed'));
  }
});

module.exports = router;

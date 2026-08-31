const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');

const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { accountPaymentsQuerySchema } = require('../../schemas');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { fetchPaymentsForAccount } = require('../../services/stellarService');

const router = express.Router();

router.get('/accounts/:account/payments', validateSchema({ query: accountPaymentsQuerySchema }), asyncHandler(async (req, res, next) => {
  const { account } = req.params;
  if (!account || !StrKey.isValidEd25519PublicKey(account)) {
    return next(new ApiError('INVALID_INPUT', 'Invalid Stellar account'));
  }

  const { limit, cursor, order } = req.query;

  try {
    const page = await fetchPaymentsForAccount({ address: account, limit, cursor, order });

    const records = page._embedded?.records || [];
    const next = page._links?.next?.href || null;
    const prev = page._links?.prev?.href || null;

    return res.json({ records, next, prev, limit, order });
  } catch (err) {
    if (err?.code === 'EOPENBREAKER') {
      return next(new ApiError('SERVICE_UNAVAILABLE', 'Stellar Horizon is temporarily unavailable; please try again later'));
    }
    if (err && err.response && err.response.status === 404) {
      return next(new ApiError('NOT_FOUND', 'Account not found'));
    }
    return next(new ApiError('UPSTREAM_ERROR', 'Failed to fetch payments from Horizon', { cause: err }));
  }
}));

module.exports = router;

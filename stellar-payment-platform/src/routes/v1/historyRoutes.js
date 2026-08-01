const express = require('express');
const { Horizon, StrKey } = require('@stellar/stellar-sdk');

const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { accountPaymentsQuerySchema } = require('../../schemas');

const router = express.Router();
const HORIZON_BASE = process.env.HORIZON_BASE || 'https://horizon-testnet.stellar.org';

router.get('/accounts/:account/payments', validateSchema({ query: accountPaymentsQuerySchema }), async (req, res, next) => {
  const { account } = req.params;
  if (!account || !StrKey.isValidEd25519PublicKey(account)) {
    return next(new ApiError('INVALID_INPUT', 'Invalid Stellar account'));
  }

  const { limit, cursor, order } = req.query;

  try {
    const server = new Horizon.Server(HORIZON_BASE);
    let call = server.payments().forAccount(account).order(order).limit(limit);
    if (cursor) call = call.cursor(cursor);
    const page = await call.call();

    const records = page._embedded?.records || [];
    const next = page._links?.next?.href || null;
    const prev = page._links?.prev?.href || null;

    return res.json({ records, next, prev, limit, order });
  } catch (err) {
    if (err && err.response && err.response.status === 404) {
      return next(new ApiError('NOT_FOUND', 'Account not found'));
    }
    return next(new ApiError('UPSTREAM_ERROR', 'Failed to fetch payments from Horizon', { cause: err }));
  }
});

module.exports = router;

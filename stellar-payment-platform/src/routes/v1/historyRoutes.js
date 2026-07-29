const express = require('express');
const { Horizon, StrKey } = require('@stellar/stellar-sdk');

const router = express.Router();
const HORIZON_BASE = process.env.HORIZON_BASE || 'https://horizon-testnet.stellar.org';

router.get('/accounts/:account/payments', async (req, res, next) => {
  const { account } = req.params;
  if (!account || !StrKey.isValidEd25519PublicKey(account)) {
    return res.status(400).json({ detail: 'Invalid Stellar account' });
  }

  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const cursor = req.query.cursor;
  const order = req.query.order === 'asc' ? 'asc' : 'desc';

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
      return res.status(404).json({ detail: 'Account not found' });
    }
    const fetchErr = new Error('Failed to fetch payments from Horizon');
    fetchErr.statusCode = 502;
    return next(fetchErr);
  }
});

module.exports = router;

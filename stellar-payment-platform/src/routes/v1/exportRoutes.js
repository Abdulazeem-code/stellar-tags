'use strict';

const express = require('express');
const { once } = require('events');
const { Horizon, StrKey } = require('@stellar/stellar-sdk');
const { validateSchema } = require('../../middleware/validateSchema');
const { exportQuerySchema } = require('../../schemas');
const { ApiError } = require('../../errors');
const { logger } = require('../../logger');
const { asyncHandler } = require('../../middleware/asyncHandler');

const router = express.Router();

const HORIZON_BASE = process.env.HORIZON_BASE || 'https://horizon-testnet.stellar.org';

// Horizon caps a page at 200. Records are converted and flushed one page at a
// time, so memory stays bounded by the page rather than by the export size.
const PAGE_SIZE = 200;

// A hard page ceiling stops a single request streaming forever.
const MAX_PAGES = Number(process.env.EXPORT_MAX_PAGES) || 500;

const COLUMNS = [
  'id',
  'created_at',
  'type',
  'from',
  'to',
  'amount',
  'asset_type',
  'asset_code',
  'asset_issuer',
  'transaction_hash',
];

/**
 * Escapes one CSV field per RFC 4180: wrap in quotes when the value contains a
 * delimiter, quote or newline, and double any embedded quotes. A leading
 * `=+-@` is prefixed with a quote so spreadsheets do not evaluate the value as
 * a formula.
 */
const escapeField = (value) => {
  if (value === null || value === undefined) return '';

  let field = String(value);
  if (/^[=+\-@]/.test(field)) {
    field = `'${field}`;
  }
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
};

/**
 * Per-type field names for the two operations in the /payments collection that
 * do not use from/to. A generic fallback chain cannot express these: an
 * account_merge names its source `account` and its destination `into`, while a
 * create_account names its source `funder` and its destination `account`.
 */
const PARTICIPANTS = {
  create_account: (record) => ({ from: record.funder, to: record.account }),
  account_merge: (record) => ({ from: record.account, to: record.into }),
};

/**
 * Normalises a Horizon payment record onto the CSV columns. Reading only the
 * `payment` field names would leave other operation types blank.
 */
const normalize = (record) => {
  const { from, to } = (PARTICIPANTS[record.type] || ((r) => ({ from: r.from, to: r.to })))(record);

  return {
    id: record.id,
    created_at: record.created_at,
    type: record.type,
    from,
    to,
    amount: record.type === 'create_account' ? record.starting_balance : record.amount,
    asset_type: record.type === 'create_account' ? 'native' : record.asset_type,
    asset_code: record.asset_code,
    asset_issuer: record.asset_issuer,
    transaction_hash: record.transaction_hash,
  };
};

const toRow = (record) => {
  const row = normalize(record);
  return `${COLUMNS.map((column) => escapeField(row[column])).join(',')}\r\n`;
};

/** Writes a chunk, waiting for drain when the socket applies backpressure. */
const writeChunk = async (res, chunk) => {
  if (!res.write(chunk)) {
    await once(res, 'drain');
  }
};

/**
 * GET /transactions/export
 *
 * Streams the account's payment history as CSV. Pages are fetched from Horizon
 * with its cursor, converted, and flushed as they arrive, so neither the full
 * result set nor the full CSV is ever held in memory.
 */
router.get(
  '/transactions/export',
  validateSchema({ query: exportQuerySchema }),
  asyncHandler(async (req, res, next) => {
    const { address, order } = req.query;

    if (!StrKey.isValidEd25519PublicKey(address)) {
      return next(new ApiError('INVALID_INPUT', 'Invalid Stellar account'));
    }

    let page;
    try {
      const server = new Horizon.Server(HORIZON_BASE);
      page = await server.payments().forAccount(address).order(order).limit(PAGE_SIZE).call();
    } catch (err) {
      if (err && err.response && err.response.status === 404) {
        return next(new ApiError('NOT_FOUND', 'Account not found'));
      }
      return next(
        new ApiError('UPSTREAM_ERROR', 'Failed to fetch transactions from Horizon', { cause: err }),
      );
    }

    // Past this point the response is committed, so a later failure can only be
    // logged and the stream cut — the error envelope needs unsent headers.
    const filename = `transactions-${address}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    let rows = 0;

    try {
      await writeChunk(res, `${COLUMNS.join(',')}\r\n`);

      let truncated = false;
      let pageCount = 0;

      for (; pageCount < MAX_PAGES; pageCount += 1) {
        const records = page.records || [];
        if (records.length === 0) break;

        for (const record of records) {
          if (res.writableEnded || req.destroyed) return;
          await writeChunk(res, toRow(record));
          rows += 1;
        }

        const exhausted = records.length < PAGE_SIZE || typeof page.next !== 'function';
        if (exhausted) break;

        if (pageCount === MAX_PAGES - 1) {
          truncated = true;
          break;
        }
        page = await page.next();
      }

      if (truncated) {
        logger.warn(
          `[Correlation ID: ${req.correlationId}] Export for ${address} hit the ` +
            `${MAX_PAGES}-page cap after ${rows} rows and was truncated`,
        );
      }

      logger.info(
        `[Correlation ID: ${req.correlationId}] Exported ${rows} transactions for ${address}`,
      );
      return res.end();
    } catch (err) {
      logger.error(
        `[Correlation ID: ${req.correlationId}] Export failed after ${rows} rows`,
        err,
      );
      return res.destroy(err);
    }
  }),
);

module.exports = router;
module.exports.COLUMNS = COLUMNS;
module.exports.escapeField = escapeField;
module.exports.normalize = normalize;

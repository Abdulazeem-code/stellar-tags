'use strict';

/**
 * src/analytics/analyticsRepository.js
 *
 * Analytics read-model repository.
 *
 * Owns the connection pool to the TimescaleDB analytics database
 * (ANALYTICS_DATABASE_URL) and provides:
 *   - initAnalyticsSchema       – idempotent DDL bootstrap
 *   - upsertPaymentAnalytics    – write path called by the analytics consumer
 *   - getRoutingStatsFromAnalytics – read path called by the API route
 *
 * When ANALYTICS_DATABASE_URL is not set the pool is null and every function
 * degrades gracefully so the application works in development without
 * TimescaleDB running.
 */

const { Pool } = require('pg');
const { logger } = require('../logger');

/** @type {import('pg').Pool|null} */
let _pool = null;

/**
 * Lazy singleton pg Pool pointed at the analytics (TimescaleDB) database.
 * Returns null when ANALYTICS_DATABASE_URL is unset.
 *
 * @returns {import('pg').Pool|null}
 */
const getAnalyticsPool = () => {
  if (_pool) return _pool;
  const url = process.env.ANALYTICS_DATABASE_URL;
  if (!url) {
    // Warn only once; the route handler will fall back to the primary DB.
    return null;
  }
  _pool = new Pool({
    connectionString: url,
    max: parseInt(process.env.ANALYTICS_POOL_MAX, 10) || 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  _pool.on('error', (err) => logger.error({ err }, 'analytics pool error'));
  return _pool;
};

/**
 * Initialise the TimescaleDB schema: create the payment_analytics hypertable
 * and the pre-aggregated daily rollup table.  Idempotent — safe to call on
 * every worker startup.
 *
 * @param {import('pg').Pool|null} [pool]
 */
const initAnalyticsSchema = async (pool = getAnalyticsPool()) => {
  if (!pool) {
    logger.warn('analytics: ANALYTICS_DATABASE_URL not set — skipping schema init');
    return;
  }
  const client = await pool.connect();
  try {
    // Raw payment events — one row per payment, partitioned by time.
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_analytics (
        id               TEXT             NOT NULL,
        created_at       TIMESTAMPTZ      NOT NULL,
        from_address     TEXT             NOT NULL,
        to_address       TEXT             NOT NULL,
        amount           DOUBLE PRECISION NOT NULL DEFAULT 0,
        fee              DOUBLE PRECISION NOT NULL DEFAULT 0,
        asset_code       TEXT,
        transaction_hash TEXT,
        status           TEXT             NOT NULL DEFAULT 'completed',
        PRIMARY KEY (id, created_at)
      );
    `);

    // Promote to a TimescaleDB hypertable; ignore if already promoted.
    await client.query(`
      SELECT create_hypertable(
        'payment_analytics', 'created_at',
        if_not_exists => TRUE,
        migrate_data  => TRUE
      );
    `).catch((err) => {
      if (!String(err.message).includes('already a hypertable')) {
        logger.warn({ err }, 'analytics: create_hypertable skipped (TimescaleDB may not be available)');
      }
    });

    // Pre-aggregated daily rollup per asset — faster for dashboard queries.
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_analytics_daily (
        period       DATE             NOT NULL,
        asset_code   TEXT             NOT NULL DEFAULT 'unknown',
        total_volume DOUBLE PRECISION NOT NULL DEFAULT 0,
        total_fees   DOUBLE PRECISION NOT NULL DEFAULT 0,
        total_count  BIGINT           NOT NULL DEFAULT 0,
        PRIMARY KEY (period, asset_code)
      );
    `);

    // Indexes for common query patterns.
    await client.query(
      `CREATE INDEX IF NOT EXISTS payment_analytics_created_at_idx
         ON payment_analytics (created_at DESC);`
    ).catch(() => {});
    await client.query(
      `CREATE INDEX IF NOT EXISTS payment_analytics_asset_code_idx
         ON payment_analytics (asset_code, created_at DESC);`
    ).catch(() => {});
    await client.query(
      `CREATE INDEX IF NOT EXISTS payment_analytics_daily_period_idx
         ON payment_analytics_daily (period DESC);`
    ).catch(() => {});

    logger.info('analytics: schema initialised');
  } finally {
    client.release();
  }
};

/**
 * Upsert a single payment event into the analytics hypertable and roll up
 * the affected daily bucket.
 *
 * @param {import('pg').Pool|null} pool
 * @param {object} payment - payment event payload from the stream
 */
const upsertPaymentAnalytics = async (pool, payment) => {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const createdAt = payment.createdAt ? new Date(payment.createdAt) : new Date();
    const amount = Number(payment.amount) || 0;
    const fee = Number(payment.fee) || 0;
    const assetCode = payment.assetCode || 'unknown';

    // 1. Upsert raw event row.
    await client.query(
      `INSERT INTO payment_analytics
         (id, created_at, from_address, to_address, amount, fee, asset_code, transaction_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id, created_at) DO UPDATE SET
         amount           = EXCLUDED.amount,
         fee              = EXCLUDED.fee,
         asset_code       = EXCLUDED.asset_code,
         transaction_hash = EXCLUDED.transaction_hash,
         status           = EXCLUDED.status`,
      [
        payment.id,
        createdAt,
        payment.fromAddress || '',
        payment.toAddress || '',
        amount,
        fee,
        assetCode,
        payment.transactionHash || null,
        payment.status || 'completed',
      ],
    );

    // 2. Roll up into the daily bucket (idempotent via INSERT … ON CONFLICT DO UPDATE).
    const dayStart = new Date(Date.UTC(
      createdAt.getUTCFullYear(),
      createdAt.getUTCMonth(),
      createdAt.getUTCDate(),
    ));
    await client.query(
      `INSERT INTO payment_analytics_daily (period, asset_code, total_volume, total_fees, total_count)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (period, asset_code) DO UPDATE SET
         total_volume = payment_analytics_daily.total_volume + EXCLUDED.total_volume,
         total_fees   = payment_analytics_daily.total_fees   + EXCLUDED.total_fees,
         total_count  = payment_analytics_daily.total_count  + 1`,
      [dayStart, assetCode, amount, fee],
    );
  } finally {
    client.release();
  }
};

/**
 * Return the ISO week Monday for a given date (YYYY-MM-DD string).
 * Matches the getBucketKey() logic in statsService.js.
 *
 * @param {Date} date
 * @returns {Date}
 */
const getMondayOf = (date) => {
  const d = new Date(date);
  const dow = d.getUTCDay(); // 0 = Sunday
  const diff = dow === 0 ? -6 : 1 - dow;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
};

/**
 * Query the analytics read model and return aggregated routing statistics.
 *
 * Mirrors the shape returned by statsService.getRoutingStats() so the admin
 * route handler is a drop-in replacement:
 *
 *   {
 *     interval, startDate, endDate,
 *     summary: { total_volume, total_fees, total_count },
 *     data: [{ period, volume, fees, count }],
 *     source: 'analytics' | 'unavailable'
 *   }
 *
 * @param {object}  opts
 * @param {string}  [opts.startDate]  YYYY-MM-DD inclusive lower bound
 * @param {string}  [opts.endDate]    YYYY-MM-DD inclusive upper bound
 * @param {string}  [opts.groupBy]    'day' | 'week' | 'month'
 * @param {string}  [opts.assetCode]  optional asset filter
 * @param {import('pg').Pool|null} [opts.pool]
 * @returns {Promise<object>}
 */
const getRoutingStatsFromAnalytics = async ({
  startDate,
  endDate,
  groupBy = 'day',
  assetCode,
  pool,
} = {}) => {
  const analyticsPool = pool !== undefined ? pool : getAnalyticsPool();

  // Degrade gracefully when TimescaleDB is not available.
  if (!analyticsPool) {
    return {
      interval: groupBy,
      startDate: startDate || null,
      endDate: endDate || null,
      summary: { total_volume: 0, total_fees: 0, total_count: 0 },
      data: [],
      source: 'unavailable',
    };
  }

  const params = [];
  const conditions = [];

  if (startDate) {
    const start = new Date(startDate);
    start.setUTCHours(0, 0, 0, 0);
    params.push(start);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);
    params.push(end);
    conditions.push(`created_at <= $${params.length}`);
  }
  if (assetCode) {
    params.push(assetCode);
    conditions.push(`asset_code = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT id, created_at, amount, fee, asset_code, status
    FROM payment_analytics
    ${where}
    ORDER BY created_at ASC
  `;

  const { rows } = await analyticsPool.query(sql, params);

  let totalVolume = 0;
  let totalFees = 0;
  let totalCount = 0;
  const buckets = new Map();

  for (const row of rows) {
    const amount = Number(row.amount) || 0;
    const fee = Number(row.fee) || 0;
    totalVolume += amount;
    totalFees += fee;
    totalCount += 1;

    // Compute bucket key matching statsService.getBucketKey()
    const d = new Date(row.created_at);
    let bucketKey;
    if (groupBy === 'month') {
      bucketKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    } else if (groupBy === 'week') {
      const mon = getMondayOf(d);
      bucketKey = [
        mon.getUTCFullYear(),
        String(mon.getUTCMonth() + 1).padStart(2, '0'),
        String(mon.getUTCDate()).padStart(2, '0'),
      ].join('-');
    } else {
      bucketKey = [
        d.getUTCFullYear(),
        String(d.getUTCMonth() + 1).padStart(2, '0'),
        String(d.getUTCDate()).padStart(2, '0'),
      ].join('-');
    }

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { period: bucketKey, volume: 0, fees: 0, count: 0 });
    }
    const b = buckets.get(bucketKey);
    b.volume = Number((b.volume + amount).toFixed(7));
    b.fees = Number((b.fees + fee).toFixed(7));
    b.count += 1;
  }

  return {
    interval: groupBy,
    startDate: startDate || null,
    endDate: endDate || null,
    summary: {
      total_volume: Number(totalVolume.toFixed(7)),
      total_fees: Number(totalFees.toFixed(7)),
      total_count: totalCount,
    },
    data: Array.from(buckets.values()),
    source: 'analytics',
  };
};

module.exports = {
  getAnalyticsPool,
  initAnalyticsSchema,
  upsertPaymentAnalytics,
  getRoutingStatsFromAnalytics,
};

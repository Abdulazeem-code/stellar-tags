// ---------------------------------------------------------------------------
// DB Pool Monitor
// ---------------------------------------------------------------------------
// Periodically queries Prisma's connection-pool metrics and logs a high-
// priority warning when active connections exceed a configurable threshold
// (default: 80 % of the pool limit).  Also warns when requests are queued
// waiting for a free connection.
//
// Prerequisite: the "metrics" preview feature must be enabled in schema.prisma
// so that `prisma.$metrics.json()` returns pool counters.
// ---------------------------------------------------------------------------

const { logger } = require('./logger');

/**
 * Fraction of the pool that must be in use before a warning is logged.
 * Override with the DB_POOL_WARN_THRESHOLD environment variable (0.0–1.0).
 */
const WARN_THRESHOLD =
  parseFloat(process.env.DB_POOL_WARN_THRESHOLD) || 0.8;

/**
 * How often (in milliseconds) the monitor checks pool metrics.
 * Override with the DB_POOL_CHECK_INTERVAL_MS environment variable.
 */
const CHECK_INTERVAL_MS =
  parseInt(process.env.DB_POOL_CHECK_INTERVAL_MS, 10) || 30_000;

/** Tracks whether metrics were unavailable on the first check (logged once). */
let metricsUnavailableLogged = false;

/**
 * Queries Prisma metrics and returns an object with the current pool snapshot.
 *
 * `$metrics.json()` returns `{ counters, gauges, histograms }`; the pool
 * counters are all gauges.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{active: number, idle: number, size: number, waiters: number} | null>}
 *   Returns null when metrics are unavailable (e.g. preview feature not enabled).
 */
async function getPoolMetrics(prisma) {
  try {
    const { gauges = [] } = await prisma.$metrics.json();

    const find = (key) => {
      const entry = gauges.find((m) => m.key === key);
      return typeof entry?.value === 'number' ? entry.value : 0;
    };

    return {
      active: find('prisma_pool_connections_busy'),
      idle: find('prisma_pool_connections_idle'),
      size: find('prisma_pool_connections_open'),
      waiters: find('prisma_client_queries_wait'),
    };
  } catch {
    // $metrics is unavailable (preview feature not enabled, or older Prisma).
    if (!metricsUnavailableLogged) {
      metricsUnavailableLogged = true;
      logger.warn(
        '[db-pool-monitor] Prisma metrics unavailable — ensure the "metrics" ' +
          'preview feature is enabled in schema.prisma and the client has been regenerated'
      );
    }
    return null;
  }
}

/**
 * Runs one pool-health check and logs warnings when usage is high.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 */
async function checkPool(prisma) {
  const metrics = await getPoolMetrics(prisma);

  if (!metrics) {
    return;
  }

  const { active, idle, size, waiters } = metrics;

  // Guard against division by zero (unlikely but defensive).
  if (size === 0) {
    return;
  }

  const usageRatio = active / size;

  if (usageRatio > WARN_THRESHOLD) {
    logger.warn(
      `[db-pool-monitor] Connection pool near exhaustion: ` +
        `${active}/${size} connections active (${(usageRatio * 100).toFixed(0)}%), ` +
        `${idle} idle, ${waiters} waiting for a connection`
    );
  }

  // Always warn when requests are queued waiting for a connection, even if
  // the raw active count hasn't crossed the threshold (e.g. pool limit is
  // very high but all connections are genuinely saturated).
  if (waiters > 0) {
    logger.warn(
      `[db-pool-monitor] ${waiters} request(s) queued waiting for a free ` +
        `database connection (active: ${active}, idle: ${idle}, pool size: ${size})`
    );
  }
}

/**
 * Starts periodic pool-usage monitoring using recursive setTimeout to prevent
 * overlapping checks when a DB operation is slow.
 *
 * Call the returned `stop()` function to cancel the monitor (e.g. during
 * graceful shutdown).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {{ stop: () => void }}
 */
function schedulePoolMonitoring(prisma) {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped) return;
    if (running) return; // skip if previous check still in-flight
    running = true;
    try {
      await checkPool(prisma);
    } finally {
      running = false;
      if (!stopped) {
        setTimeout(tick, CHECK_INTERVAL_MS).unref();
      }
    }
  };

  // Kick off the first check immediately (async, fire-and-forget).
  tick();

  logger.info(
    `[db-pool-monitor] Pool monitor started — checking every ${CHECK_INTERVAL_MS / 1000}s, ` +
      `warn threshold: ${(WARN_THRESHOLD * 100).toFixed(0)}%`
  );

  return {
    stop: () => {
      stopped = true;
    },
  };
}

module.exports = { schedulePoolMonitoring, getPoolMetrics, checkPool };

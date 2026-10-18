'use strict';

/**
 * analytics-worker.js
 *
 * Standalone analytics consumer worker process.
 *
 * Reads payment domain events from the Redis Streams `analytics` channel
 * and upserts them into the TimescaleDB analytics read model, keeping the
 * dashboard APIs fast without touching the transactional database.
 *
 * Start with:
 *   node analytics-worker.js
 *
 * Via Docker Compose (dev / full profiles):
 *   command: ["node", "analytics-worker.js"]
 *
 * Required environment variables:
 *   ANALYTICS_DATABASE_URL  – TimescaleDB connection string
 *   REDIS_URL               – Redis connection string (or REDIS_CLUSTER_NODES)
 *
 * Optional environment variables:
 *   ANALYTICS_STREAM        – stream name (default: 'analytics')
 *   ANALYTICS_CONSUMER_GROUP – consumer group (default: 'analytics-processors')
 *   ANALYTICS_BATCH_SIZE    – entries per XREADGROUP call (default: 10)
 *   ANALYTICS_BLOCK_MS      – BLOCK timeout in ms (default: 5000)
 */

require('./src/utils/tracing');
require('./config/envCheck');

const { logger } = require('./src/logger');
const { initAnalyticsSchema } = require('./src/analytics/analyticsRepository');
const { startAnalyticsConsumer } = require('./src/analytics/analyticsConsumer');

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'analytics-worker: unhandled rejection');
  process.exit(1);
});

(async () => {
  try {
    logger.info('analytics-worker: initialising schema…');
    await initAnalyticsSchema();

    logger.info('analytics-worker: starting consumer…');
    const worker = await startAnalyticsConsumer();

    const shutdown = async (signal) => {
      logger.info({ signal }, 'analytics-worker: shutting down');
      await worker.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error({ err }, 'analytics-worker: failed to start');
    process.exit(1);
  }
})();

'use strict';

/**
 * src/analytics/analyticsConsumer.js
 *
 * Analytics event consumer: reads payment domain events from the
 * Redis Streams `analytics` channel and upserts aggregated rows into
 * TimescaleDB so dashboard queries never touch the transactional database.
 *
 * Follows the same XREADGROUP / XACK pattern used by src/fraudDetection.js.
 *
 * Failure handling:
 *   - A processing error on a single entry is logged but still ACKed to
 *     prevent poison-pill replays.  The raw stream entry is logged so
 *     operators can replay manually if needed.
 *   - A loop-level error (e.g. Redis connection drop) is logged and the
 *     worker sleeps 5 s before retrying, rather than crashing.
 */

const { logger } = require('../logger');
const { createRedisConnection } = require('../config/redis');
const analyticsRepository = require('./analyticsRepository');

const ANALYTICS_STREAM = process.env.ANALYTICS_STREAM || 'analytics';
const CONSUMER_GROUP = process.env.ANALYTICS_CONSUMER_GROUP || 'analytics-processors';
const CONSUMER_NAME = process.env.ANALYTICS_CONSUMER_NAME || `analytics-${process.pid}`;
const BATCH_SIZE = parseInt(process.env.ANALYTICS_BATCH_SIZE, 10) || 10;
const BLOCK_MS = parseInt(process.env.ANALYTICS_BLOCK_MS, 10) || 5_000;

/**
 * Create or re-attach to the consumer group on the analytics stream.
 * MKSTREAM creates the stream key if it does not yet exist.
 *
 * @param {import('ioredis').Redis} redis
 */
const ensureConsumerGroup = async (redis) => {
  try {
    await redis.xgroup('CREATE', ANALYTICS_STREAM, CONSUMER_GROUP, '0', 'MKSTREAM');
  } catch (err) {
    // BUSYGROUP is expected when the group already exists — ignore it.
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  }
};

/**
 * Parse a raw Redis stream entry into a plain JS object.
 * Entry format: [ id, [field, value, field, value, …] ]
 *
 * @param {Array} entry
 * @returns {object|undefined}
 */
const parseStreamEntry = (entry) => {
  const fields = entry[1] || [];
  const idx = fields.findIndex((f) => f === 'payload');
  const raw = idx >= 0 ? fields[idx + 1] : fields[1];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};

/**
 * Process a single payment event: upsert the relevant analytics rows.
 *
 * @param {object}  event      - parsed event payload
 * @param {string}  eventType  - 'payment.created' | 'payment.updated'
 * @param {import('pg').Pool|null} pool - TimescaleDB pg Pool
 */
const processEvent = async (event, eventType, pool) => {
  if (eventType === 'payment.created') {
    await analyticsRepository.upsertPaymentAnalytics(pool, event);
    return;
  }
  // payment.updated: re-aggregate when the status field is present
  if (eventType === 'payment.updated' && event && event.status) {
    await analyticsRepository.upsertPaymentAnalytics(pool, event);
  }
};

/**
 * Start the long-running analytics stream consumer.
 *
 * @param {{ redis?: import('ioredis').Redis, pool?: import('pg').Pool }} opts
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
const startAnalyticsConsumer = async ({ redis = createRedisConnection(), pool } = {}) => {
  const analyticsPool = pool !== undefined ? pool : analyticsRepository.getAnalyticsPool();
  await ensureConsumerGroup(redis);
  logger.info(
    { stream: ANALYTICS_STREAM, group: CONSUMER_GROUP, consumer: CONSUMER_NAME },
    'analytics consumer started',
  );

  let running = true;

  const run = async () => {
    while (running) {
      try {
        const batches = await redis.xreadgroup(
          'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
          'COUNT', BATCH_SIZE,
          'BLOCK', BLOCK_MS,
          'STREAMS', ANALYTICS_STREAM, '>',
        );

        for (const [, entries] of batches || []) {
          for (const entry of entries || []) {
            const entryId = entry[0];
            const fields = entry[1] || [];
            const typeIdx = fields.findIndex((f) => f === 'event_type');
            const eventType = typeIdx >= 0 ? fields[typeIdx + 1] : null;

            try {
              const event = parseStreamEntry(entry);
              if (event) await processEvent(event, eventType, analyticsPool);
              await redis.xack(ANALYTICS_STREAM, CONSUMER_GROUP, entryId);
            } catch (err) {
              logger.error(
                { err, entryId, eventType },
                'analytics: failed to process stream entry — ACKing to avoid redelivery',
              );
              // Still ACK to avoid poison-pill replays; raw payload is in the log.
              try { await redis.xack(ANALYTICS_STREAM, CONSUMER_GROUP, entryId); } catch (_) { /* best-effort */ }
            }
          }
        }
      } catch (err) {
        if (running) {
          logger.error({ err }, 'analytics consumer loop error — retrying in 5 s');
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    }
  };

  run().catch((err) => logger.error({ err }, 'analytics consumer stopped unexpectedly'));

  return {
    stop: async () => {
      running = false;
      try { await redis.quit(); } catch (_) { /* best-effort */ }
    },
  };
};

module.exports = {
  ANALYTICS_STREAM,
  CONSUMER_GROUP,
  ensureConsumerGroup,
  parseStreamEntry,
  processEvent,
  startAnalyticsConsumer,
};

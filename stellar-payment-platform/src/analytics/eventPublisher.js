'use strict';

/**
 * src/analytics/eventPublisher.js
 *
 * Publishes payment domain events to the Redis Streams analytics channel.
 * Called from the payment write path to fan events out to the analytics
 * consumer without coupling the two systems together.
 *
 * Design notes:
 *  - All publish calls are fire-and-forget: failures are logged as warnings
 *    but never propagate to the caller.  The transactional database is always
 *    the authoritative source of truth; analytics lag is acceptable.
 *  - MAXLEN trimming keeps the stream bounded (~10 k entries by default) so
 *    a slow consumer cannot exhaust Redis memory.
 */

const { logger } = require('../logger');

const ANALYTICS_STREAM = process.env.ANALYTICS_STREAM || 'analytics';
const MAX_STREAM_LEN = parseInt(process.env.ANALYTICS_STREAM_MAX_LEN, 10) || 10_000;

/**
 * Publish a payment.created event to the analytics stream.
 *
 * @param {import('ioredis').Redis|null} redis - live ioredis connection; no-op when null
 * @param {object} payment - Prisma Payment record fields
 * @returns {Promise<string|null>} Redis stream entry id, or null on failure
 */
const publishPaymentCreated = async (redis, payment) => {
  if (!redis) return null;
  try {
    const id = await redis.xadd(
      ANALYTICS_STREAM,
      'MAXLEN', '~', MAX_STREAM_LEN,
      '*',
      'event_type', 'payment.created',
      'payload', JSON.stringify({
        id: payment.id,
        createdAt: payment.createdAt instanceof Date
          ? payment.createdAt.toISOString()
          : payment.createdAt,
        fromAddress: payment.fromAddress,
        toAddress: payment.toAddress,
        amount: payment.amount,
        fee: payment.fee ?? 0,
        assetCode: payment.assetCode ?? null,
        transactionHash: payment.transactionHash ?? null,
        status: payment.status ?? 'completed',
      }),
    );
    logger.debug({ streamId: id, paymentId: payment.id }, 'analytics: payment.created published');
    return id;
  } catch (err) {
    // Non-fatal: analytics lag is acceptable; transactional DB is source of truth.
    logger.warn({ err, paymentId: payment.id }, 'analytics: failed to publish payment.created');
    return null;
  }
};

/**
 * Publish a payment.updated event (e.g. fraud flag) to the analytics stream.
 *
 * @param {import('ioredis').Redis|null} redis
 * @param {object} payment - partial payment fields, at minimum { id }
 * @returns {Promise<string|null>}
 */
const publishPaymentUpdated = async (redis, payment) => {
  if (!redis) return null;
  try {
    const id = await redis.xadd(
      ANALYTICS_STREAM,
      'MAXLEN', '~', MAX_STREAM_LEN,
      '*',
      'event_type', 'payment.updated',
      'payload', JSON.stringify({
        id: payment.id,
        updatedAt: new Date().toISOString(),
        ...payment,
      }),
    );
    logger.debug({ streamId: id, paymentId: payment.id }, 'analytics: payment.updated published');
    return id;
  } catch (err) {
    logger.warn({ err, paymentId: payment.id }, 'analytics: failed to publish payment.updated');
    return null;
  }
};

module.exports = {
  ANALYTICS_STREAM,
  publishPaymentCreated,
  publishPaymentUpdated,
};

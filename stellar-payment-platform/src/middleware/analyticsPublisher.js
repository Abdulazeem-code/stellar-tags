'use strict';

/**
 * src/middleware/analyticsPublisher.js
 *
 * Express middleware that intercepts outgoing responses on payment write
 * endpoints and publishes domain events to the analytics Redis stream.
 *
 * Usage:
 *   router.post('/payments', analyticsPublisherMiddleware(redisClient), handler);
 *
 * The middleware patches res.json() so the analytics publish fires after the
 * response has already been sent to the client — it never adds latency.
 * Failures are logged as warnings and never re-thrown.
 */

const { publishPaymentCreated, publishPaymentUpdated } = require('../analytics/eventPublisher');
const { logger } = require('../logger');

/**
 * Factory: returns Express middleware bound to the given Redis connection.
 *
 * @param {import('ioredis').Redis|null} redis
 * @returns {import('express').RequestHandler}
 */
const analyticsPublisherMiddleware = (redis) => (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    // Fire-and-forget: the client already received the response before we publish.
    setImmediate(async () => {
      try {
        if (res.statusCode >= 200 && res.statusCode < 300 && body) {
          // Detect a payment object in the response body.
          const payment = body.payment || body.data || (body.id ? body : null);
          if (payment && payment.id) {
            if (req.method === 'POST') {
              await publishPaymentCreated(redis, payment);
            } else if (req.method === 'PUT' || req.method === 'PATCH') {
              await publishPaymentUpdated(redis, payment);
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, 'analyticsPublisher: failed to publish event');
      }
    });

    return originalJson(body);
  };

  next();
};

module.exports = { analyticsPublisherMiddleware };

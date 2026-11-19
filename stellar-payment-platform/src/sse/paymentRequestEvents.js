// ---------------------------------------------------------------------------
// Payment request status notifications (#1046)
// ---------------------------------------------------------------------------
// One call site for "a payment request changed state" so the routes that cancel
// a request (#1044) and the Horizon matcher that marks it paid (#1045) emit
// exactly the same event shape:
//
//   { paymentId: <requestId>, status, type: 'payment_request',
//     transactionHash?, paidAt? }
//
// With Redis configured the update goes through publishPaymentRequestUpdate()
// and every API node fans it out to its connected streams. Without Redis the
// update is emitted in-process, which keeps single-node deployments (and the
// test suite) working and can never crash the caller.
// ---------------------------------------------------------------------------

'use strict';

const { logger } = require('../logger');
const {
  emitPaymentUpdate,
  publishPaymentRequestUpdate,
  PAYMENT_REQUEST_EVENT_TYPE,
} = require('./index');

/** Statuses a PaymentRequest can legitimately report. */
const PAYMENT_REQUEST_STATUSES = new Set([
  'pending',
  'paid',
  'cancelled',
  'expired',
]);

/**
 * Broadcast a PaymentRequest status change to everyone watching its stream.
 *
 * @param {object} params
 * @param {import('ioredis').Redis | null} params.redisPublisher - publisher connection, or null.
 * @param {string} params.requestId        - PaymentRequest id clients subscribed to.
 * @param {string} params.status           - pending | paid | cancelled | expired.
 * @param {string} [params.transactionHash]- Stellar transaction that paid the request.
 * @param {Date|string} [params.paidAt]    - When the payment was matched.
 * @returns {Promise<boolean>} true when the update was handed off (never throws).
 */
const notifyPaymentRequestUpdate = async ({
  redisPublisher,
  requestId,
  status,
  transactionHash,
  paidAt,
} = {}) => {
  if (!requestId || typeof requestId !== 'string') {
    logger.warn(
      '[sse] notifyPaymentRequestUpdate called without a requestId; skipping.',
    );
    return false;
  }

  if (!PAYMENT_REQUEST_STATUSES.has(status)) {
    logger.warn(
      { requestId, status },
      '[sse] notifyPaymentRequestUpdate called with an unknown status; skipping.',
    );
    return false;
  }

  const payload = { status };
  if (transactionHash) payload.transactionHash = transactionHash;
  if (paidAt) {
    payload.paidAt = paidAt instanceof Date ? paidAt.toISOString() : paidAt;
  }

  if (redisPublisher) {
    try {
      await publishPaymentRequestUpdate(redisPublisher, requestId, payload);
      return true;
    } catch (err) {
      // Fall through to the in-process path: a Redis outage must not stop a
      // local client from getting the update, and must not fail the caller.
      logger.error(
        { err, requestId },
        '[sse] Failed to publish payment request update to Redis; falling back to in-process delivery',
      );
    }
  }

  emitPaymentUpdate(requestId, {
    ...payload,
    type: PAYMENT_REQUEST_EVENT_TYPE,
  });
  return true;
};

module.exports = {
  notifyPaymentRequestUpdate,
  PAYMENT_REQUEST_STATUSES,
};

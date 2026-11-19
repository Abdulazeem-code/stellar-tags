'use strict';

const express = require('express');
const { prisma } = require('../../../prismaClient');
const { errorBody } = require('../../errors');
const { logger } = require('../../logger');
const { addClient, sendClientEvent } = require('../../sse');
const { createTokenBucketLimiter } = require('../../middleware/tokenBucketLimiter');

// Payment ids are Prisma UUIDs; external references may be Stellar public keys.
// A conservative charset and length keeps odd characters out of logs and
// prevents the id from being reused as a free-form log/URL fragment.
const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Last known status for a payment, used as the snapshot sent on (re)connect so
 * an EventSource that just re-established its stream converges immediately
 * instead of waiting for the next transition.
 *
 * The id may belong to a Payment, a PaymentIntent or a PaymentRequest (#1046),
 * so the lookup walks all three. A pending request past `expiresAt` reports as
 * `expired`, matching how the request API computes expiry on read.
 *
 * @param {string} paymentId
 * @returns {Promise<object | null>}
 */
const loadSnapshot = async (paymentId) => {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { status: true, transactionHash: true },
  });
  if (payment) return payment;

  const intent = await prisma.paymentIntent.findUnique({
    where: { id: paymentId },
    select: { status: true },
  });
  if (intent) return intent;

  // `paymentRequest` is optional so the route keeps working against an older
  // generated Prisma client (before the model existed) instead of throwing.
  if (!prisma.paymentRequest) return null;

  const request = await prisma.paymentRequest.findUnique({
    where: { id: paymentId },
    select: {
      status: true,
      transactionHash: true,
      paidAt: true,
      expiresAt: true,
    },
  });
  if (!request) return null;

  const expired =
    request.status === 'pending' &&
    request.expiresAt &&
    request.expiresAt.getTime() <= Date.now();

  return {
    status: expired ? 'expired' : request.status,
    transactionHash: request.transactionHash,
    paidAt: request.paidAt,
    expiresAt: request.expiresAt,
    type: 'payment_request',
  };
};

/** Turn a snapshot row into the `snapshot` event payload. */
const snapshotData = (paymentId, snapshot) => {
  const data = { paymentId, status: snapshot.status };
  if (snapshot.transactionHash) data.transactionHash = snapshot.transactionHash;
  if (snapshot.paidAt) {
    data.paidAt =
      snapshot.paidAt instanceof Date
        ? snapshot.paidAt.toISOString()
        : snapshot.paidAt;
  }
  if (snapshot.expiresAt) {
    data.expiresAt =
      snapshot.expiresAt instanceof Date
        ? snapshot.expiresAt.toISOString()
        : snapshot.expiresAt;
  }
  if (snapshot.type) data.type = snapshot.type;
  return data;
};

module.exports = (redisClient) => {
  const router = express.Router();

  // Per-IP budget for opening streams. SSE connections are exempt from the
  // global token bucket (a native EventSource reconnect loop must not burn the
  // caller's REST quota) but stay bounded here so a single client cannot open
  // an unbounded number of streams.
  const streamLimiter = createTokenBucketLimiter(redisClient, {
    capacity: 60,
    refillRate: 60 / (15 * 60), // 60 stream opens per 15 minutes
    prefix: 'sse-rl:',
    keyGenerator: (req) => req.ip || (req.connection && req.connection.remoteAddress) || '',
  });

  /**
   * @openapi
   * /payments/{paymentId}/events:
   *   get:
   *     tags:
   *       - v1
   *     description: >
   *       Server-Sent Events stream of payment status updates. Responds with
   *       `text/event-stream` and stays open until the client disconnects.
   *       Emits `connected`, an initial `snapshot` (when the payment exists),
   *       then `payment-update` on every status change. Reconnection is
   *       handled natively by the browser's EventSource API.
   *     parameters:
   *       - in: path
   *         name: paymentId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Open SSE stream of payment status updates
   *       400:
   *         description: Invalid paymentId
   *
   * /payment-requests/{id}/events:
   *   get:
   *     tags:
   *       - v1
   *     description: >
   *       Alias of `/payments/{id}/events` for payment request streams (#1046).
   *       Emits the same `connected`, `snapshot` and `payment-update` events;
   *       request payloads also carry `type: "payment_request"`.
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Open SSE stream of payment request status updates
   *       400:
   *         description: Invalid id
   */
  router.get(
    ['/payments/:paymentId/events', '/payment-requests/:paymentId/events'],
    streamLimiter,
    (req, res) => {
      const { paymentId } = req.params;

      if (!PAYMENT_ID_PATTERN.test(paymentId)) {
        return res.status(400).json(
          errorBody(
            'INVALID_INPUT',
            'paymentId must be 1-128 characters of A-Z, a-z, 0-9, "_" or "-".',
            { correlationId: req.correlationId },
          ),
        );
      }

      // Headers are flushed synchronously, before any async work: the 10s
      // connect-timeout clears itself once headers are written, and the
      // `no-transform` cache-control stops compression from buffering the stream.
      const client = addClient(req, res, paymentId);

      // Best-effort snapshot. The client is already registered, so a live
      // update that lands during the query still reaches it; in that case the
      // snapshot is skipped because the live update is strictly newer than
      // whatever the query returned.
      loadSnapshot(paymentId)
        .then((snapshot) => {
          if (!snapshot || client.receivedUpdate) return;
          sendClientEvent(client, 'snapshot', snapshotData(paymentId, snapshot));
        })
        .catch((err) => {
          logger.warn({ err, paymentId }, '[sse] Failed to load status snapshot');
        });

      // No next(): the response stays open for the lifetime of the stream.
    },
  );

  return router;
};

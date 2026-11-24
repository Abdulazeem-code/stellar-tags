'use strict';

// Moves pending payment requests past their expiresAt to `expired` and sends
// the payment_request.expired webhook (#1047). Until this runs, the API already
// reports such requests as expired (computed on read); the sweep persists the
// state so the webhook fires exactly once per request.

const cron = require('node-cron');
const { logger } = require('./logger');
const { dispatchPaymentRequestWebhooks } = require('./webhookWorker');

const EXPIRY_CRON = process.env.PAYMENT_REQUEST_EXPIRY_CRON || '* * * * *';
const EXPIRY_BATCH_SIZE = 500;

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} [options]
 * @param {Function} [options.dispatch] - webhook dispatcher override (tests).
 * @param {Date} [options.now]
 * @returns {Promise<{ expired: number }>}
 */
async function runPaymentRequestExpirySweep(prisma, options = {}) {
  const dispatch = options.dispatch || dispatchPaymentRequestWebhooks;
  const now = options.now || new Date();

  const due = await prisma.paymentRequest.findMany({
    where: { status: 'pending', expiresAt: { lte: now } },
    orderBy: { expiresAt: 'asc' },
    take: EXPIRY_BATCH_SIZE,
  });

  let expired = 0;
  for (const request of due) {
    // Guard on status so a request paid or cancelled in the meantime is left alone.
    const updated = await prisma.paymentRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: 'expired' },
    });
    if (updated.count !== 1) continue;
    expired += 1;

    try {
      await dispatch({ prisma, request: { ...request, status: 'expired' }, status: 'expired' });
    } catch (error) {
      logger.error(
        { err: error, paymentRequestId: request.id },
        '[payment-request-expiry] expired webhook dispatch failed',
      );
    }
  }

  return { expired };
}

function schedulePaymentRequestExpiryJob(prisma) {
  // Runs every minute, so unlike the daily jobs it would fire during test runs
  // that load server.js and hit the real database. The sweep itself is tested
  // through runPaymentRequestExpirySweep.
  if (process.env.NODE_ENV === 'test') return;
  let running = false;
  cron.schedule(EXPIRY_CRON, async () => {
    if (running) return;
    running = true;
    try {
      const { expired } = await runPaymentRequestExpirySweep(prisma);
      if (expired) logger.info(`[payment-request-expiry] Expired ${expired} payment request(s)`);
    } catch (error) {
      logger.error('[payment-request-expiry] Sweep failed:', error.message);
    } finally {
      running = false;
    }
  });
  logger.info(`[payment-request-expiry] Expiry sweep scheduled (${EXPIRY_CRON}).`);
}

module.exports = {
  runPaymentRequestExpirySweep,
  schedulePaymentRequestExpiryJob,
  EXPIRY_BATCH_SIZE,
};

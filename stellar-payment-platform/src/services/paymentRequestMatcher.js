'use strict';

const { logger } = require('../logger');
const { fetchTransaction } = require('./stellarService');
const { paymentRequestsPaidTotal } = require('../metrics');

const decimalToUnits = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, '0'));
};

const normalizeAsset = (payment) => {
  if (payment.asset_type === 'native') return 'XLM';
  if (payment.asset_code) {
    return payment.asset_issuer
      ? `${payment.asset_code}:${payment.asset_issuer}`
      : payment.asset_code;
  }
  return null;
};

/**
 * Match one incoming Horizon payment operation to a pending payment request.
 * @returns {Promise<string[]>} IDs of requests transitioned to paid
 */
async function matchPayment(prisma, payment, options = {}) {
  const destination = payment?.to;
  if (!destination) return [];

  const requests = await prisma.paymentRequest.findMany({
    where: {
      destination,
      status: { in: ['pending', 'cancelled'] },
    },
  });

  if (!requests.length) return [];

  const now = new Date();
  const pending = requests.filter((request) =>
    request.status === 'pending' &&
    (!request.expiresAt || new Date(request.expiresAt) > now),
  );

  for (const request of requests) {
    if (request.status === 'cancelled') {
      logger.info({ paymentRequestId: request.id }, 'Payment ignored for cancelled payment request');
    } else if (request.expiresAt && new Date(request.expiresAt) <= now) {
      logger.info({ paymentRequestId: request.id }, 'Payment ignored for expired payment request');
    }
  }

  if (!pending.length) return [];

  let transaction;
  try {
    const getTransaction = options.fetchTransaction || fetchTransaction;
    transaction = await getTransaction(payment.transaction_hash);
  } catch (error) {
    logger.error(
      { err: error, transactionHash: payment.transaction_hash },
      '[payment-request-matcher] Failed to load transaction memo',
    );
    return [];
  }

  const transactionMemo = transaction?.memo ?? null;
  const paidAsset = normalizeAsset(payment);
  const paidAmount = decimalToUnits(payment.amount);
  if (paidAmount === null) return [];

  const paidIds = [];
  for (const request of pending) {
    if (request.asset !== paidAsset) continue;
    if (request.memo !== transactionMemo) continue;

    const requestedAmount = decimalToUnits(request.amount);
    if (requestedAmount === null) continue;
    if (paidAmount < requestedAmount) {
      logger.info(
        { paymentRequestId: request.id, paidAmount: payment.amount, requestedAmount: request.amount },
        'Underpayment ignored for payment request',
      );
      continue;
    }

    try {
      const updated = await prisma.paymentRequest.updateMany({
        where: {
          id: request.id,
          status: 'pending',
        },
        data: {
          status: 'paid',
          paidAt: now,
          transactionHash: payment.transaction_hash,
        },
      });
      if (updated.count === 1) {
        paidIds.push(request.id);
        paymentRequestsPaidTotal.inc();
      }
    } catch (error) {
      logger.error(
        { err: error, paymentRequestId: request.id },
        '[payment-request-matcher] Failed to mark payment request paid',
      );
    }
  }

  return paidIds;
}

module.exports = {
  matchPayment,
  decimalToUnits,
  normalizeAsset,
};

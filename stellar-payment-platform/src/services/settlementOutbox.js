'use strict';

/**
 * Durable payment notifications, separate from the in-memory settlement
 * OutboxEngine. The payment row/event and notification are committed together;
 * broker I/O never takes place inside a database transaction.
 *
 * Delivery is at-least-once. Consumers MUST deduplicate on the message id:
 * a worker can publish successfully and crash before recording PROCESSED.
 */
const { randomUUID } = require('node:crypto');

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 60_000;

function asIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function paymentPayload(payment) {
  return {
    paymentId: payment.id,
    status: payment.status,
    transactionHash: payment.transactionHash ?? null,
    fromAddress: payment.fromAddress,
    toAddress: payment.toAddress,
    amount: payment.amount,
    fee: payment.fee ?? 0,
    assetCode: payment.assetCode ?? null,
    createdAt: asIso(payment.createdAt),
  };
}

async function createPaymentWithOutbox(prismaClient, data) {
  return prismaClient.$transaction(async (tx) => {
    const payment = await tx.payment.create({ data });
    await tx.outboxMessage.create({
      data: { eventType: 'payment.created', payload: paymentPayload(payment) },
    });
    return payment;
  });
}

async function updatePaymentWithOutbox(prismaClient, id, changes) {
  return prismaClient.$transaction(async (tx) => {
    const payment = await tx.payment.update({ where: { id }, data: changes });
    await tx.outboxMessage.create({
      data: { eventType: 'payment.updated', payload: paymentPayload(payment) },
    });
    return payment;
  });
}

/**
 * Claim/lease rows with a conditional update. Only one competing worker wins
 * each row, and crashed workers release their claim automatically on expiry.
 * A lease must outlast the configured publish timeout.
 */
async function processOutboxBatch({
  prismaClient,
  publisher,
  batchSize = 25,
  leaseMs = 60_000,
  now = () => new Date(),
  logger = null,
}) {
  if (!prismaClient || typeof publisher !== 'function') {
    throw new TypeError('prismaClient and publisher are required');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new RangeError('batchSize and leaseMs must be positive integers');
  }

  const tick = now();
  const eligible = {
    status: { in: ['PENDING', 'FAILED'] },
    nextAttemptAt: { lte: tick },
    OR: [{ lockedUntil: null }, { lockedUntil: { lt: tick } }],
  };
  const candidates = await prismaClient.outboxMessage.findMany({
    where: eligible,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: batchSize,
  });
  const result = { claimed: 0, processed: 0, failed: 0 };

  for (const message of candidates) {
    const lockOwner = randomUUID();
    const leaseUntil = new Date(tick.getTime() + leaseMs);
    const claim = await prismaClient.outboxMessage.updateMany({
      where: { id: message.id, ...eligible },
      data: { lockOwner, lockedUntil: leaseUntil },
    });
    if (claim.count !== 1) continue;
    result.claimed += 1;

    // Never swallow a database write failure: the lease will expire and the
    // record remains retryable. This prevents an invisible loss of events.
    try {
      await publisher(message);
    } catch (error) {
      const retries = message.retries + 1;
      const delayMs = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(retries - 1, 6));
      await prismaClient.outboxMessage.updateMany({
        where: { id: message.id, lockOwner },
        data: {
          status: 'FAILED',
          retries: { increment: 1 },
          nextAttemptAt: new Date(now().getTime() + delayMs),
          lockedUntil: null,
          lockOwner: null,
          lastError: String(error?.message || error).slice(0, 1000),
        },
      });
      result.failed += 1;
      if (logger) logger.warn({ err: error, outboxId: message.id, retries }, 'Outbox publication failed; retry scheduled');
      continue;
    }

    const updated = await prismaClient.outboxMessage.updateMany({
      where: { id: message.id, lockOwner },
      data: {
        status: 'PROCESSED',
        processedAt: now(),
        lockedUntil: null,
        lockOwner: null,
        lastError: null,
      },
    });
    if (updated.count === 1) result.processed += 1;
    // If the lease expired meanwhile, another worker may republish. The
    // message id is stable so downstream consumers can deduplicate.
  }
  return result;
}

/** Start a non-overlapping poll loop. The first pass runs immediately. */
function startOutboxPoller({ intervalMs = 2000, ...options }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError('intervalMs must be a positive integer');
  }
  let stopped = false;
  let timer = null;
  let running = null;

  async function poll() {
    if (stopped) return;
    running = processOutboxBatch(options)
      .catch((error) => {
        if (options.logger) options.logger.error({ err: error }, 'Outbox poll failed');
      })
      .finally(() => {
        running = null;
        if (!stopped) timer = setTimeout(poll, intervalMs);
      });
    await running;
  }

  void poll();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (running) await running;
    },
  };
}

module.exports = {
  createPaymentWithOutbox,
  updatePaymentWithOutbox,
  processOutboxBatch,
  startOutboxPoller,
};

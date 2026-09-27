const crypto = require('crypto');
const { logger } = require('./logger');
const { createRedisConnection } = require('./config/redis');
const { enqueueWebhookDelivery } = require('./webhookWorker');

const PAYMENT_STREAM = process.env.PAYMENT_STREAM || 'payments';
const CONSUMER_GROUP = process.env.FRAUD_CONSUMER_GROUP || 'fraud-detectors';
const CONSUMER_NAME = process.env.FRAUD_CONSUMER_NAME || `fraud-${process.pid}`;
const HIGH_RISK_THRESHOLD = Number(process.env.FRAUD_HIGH_RISK_THRESHOLD || 0.8);

// A dependency-free, bounded anomaly scorer for the stream worker. It uses
// robust rolling statistics for amount magnitude and combines them with burst
// velocity, which keeps the worker small and explainable for compliance staff.
const createFraudScorer = ({ windowSize = 100 } = {}) => {
  const amounts = [];
  const recentSenders = new Map();
  return (payment) => {
    const amount = Math.max(0, Number(payment.amount) || 0);
    const now = Date.now();
    const sender = payment.from || 'unknown';
    const recent = (recentSenders.get(sender) || []).filter((timestamp) => now - timestamp < 60_000);
    recent.push(now);
    recentSenders.set(sender, recent);
    amounts.push(amount);
    if (amounts.length > windowSize) amounts.shift();

    const sorted = [...amounts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || amount || 1;
    const amountSignal = Math.min(1, amount / Math.max(median * 10, 1));
    const velocitySignal = Math.min(1, Math.max(0, recent.length - 3) / 7);
    const score = Math.min(1, amountSignal * 0.65 + velocitySignal * 0.35);
    return { score: Number(score.toFixed(4)), reason: `amount=${amountSignal.toFixed(2)}, velocity=${velocitySignal.toFixed(2)}` };
  };
};

const parseStreamEntry = (entry) => {
  const fields = entry[1] || [];
  const index = fields.findIndex((field) => field === 'payload');
  const raw = index >= 0 ? fields[index + 1] : fields[1];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};

const ensureGroup = async (redis) => {
  try {
    await redis.xgroup('CREATE', PAYMENT_STREAM, CONSUMER_GROUP, '0', 'MKSTREAM');
  } catch (error) {
    if (!String(error.message).includes('BUSYGROUP')) throw error;
  }
};

const notifyCompliance = async (prisma, payment, alert, queue) => {
  const webhooks = await prisma.webhook.findMany({
    where: { user: { address: payment.to } },
    select: { id: true, username: true, url: true, secret: true, events: true },
  });
  const payload = {
    event: 'fraud.detected',
    event_id: `fraud-${alert.eventId}`,
    timestamp: new Date().toISOString(),
    data: { ...payment, risk_score: alert.riskScore, reason: alert.reason, alert_id: alert.id },
  };
  const matching = webhooks.filter((webhook) => {
    const events = Array.isArray(webhook.events) ? webhook.events : ['*'];
    return events.includes('*') || events.includes('fraud.detected');
  });
  await Promise.all(matching.map((webhook) => enqueueWebhookDelivery(webhook, payload, queue)));
};

const handlePayment = async ({ prisma, payment, scorer, queue }) => {
  const { score, reason } = scorer(payment);
  if (score < HIGH_RISK_THRESHOLD) return { score, flagged: false };
  const eventId = payment.event_id || payment.transaction_hash || crypto.createHash('sha256').update(JSON.stringify(payment)).digest('hex');
  const alert = await prisma.fraudAlert.upsert({
    where: { eventId },
    create: {
      eventId,
      transactionHash: payment.transaction_hash || null,
      fromAddress: payment.from,
      toAddress: payment.to,
      amount: Number(payment.amount) || 0,
      riskScore: score,
      reason,
      rawEvent: payment,
    },
    update: { riskScore: score, reason, rawEvent: payment },
  });
  if (payment.transaction_hash) {
    await prisma.payment.updateMany({
      where: { transactionHash: payment.transaction_hash },
      data: { riskScore: score, fraudStatus: 'flagged', fraudFlaggedAt: new Date() },
    });
  }
  await notifyCompliance(prisma, payment, alert, queue);
  logger.warn({ eventId, traceId: payment.trace_id, riskScore: score }, 'High-risk payment flagged');
  return { score, flagged: true };
};

const startFraudDetectionWorker = async ({ prisma, redis = createRedisConnection(), queue } = {}) => {
  await ensureGroup(redis);
  const scorer = createFraudScorer();
  let running = true;
  const run = async () => {
    while (running) {
      const batches = await redis.xreadgroup('GROUP', CONSUMER_GROUP, CONSUMER_NAME, 'COUNT', 10, 'BLOCK', 5000, 'STREAMS', PAYMENT_STREAM, '>');
      for (const [, entries] of batches || []) {
        for (const entry of entries || []) {
          try {
            const payment = parseStreamEntry(entry);
            if (payment?.from && payment?.to) await handlePayment({ prisma, payment, scorer, queue });
            await redis.xack(PAYMENT_STREAM, CONSUMER_GROUP, entry[0]);
          } catch (error) {
            logger.error({ err: error, stream: PAYMENT_STREAM }, 'Fraud stream message failed');
          }
        }
      }
    }
  };
  run().catch((error) => logger.error({ err: error }, 'Fraud worker stopped unexpectedly'));
  return { stop: async () => { running = false; await redis.quit(); } };
};

module.exports = { PAYMENT_STREAM, HIGH_RISK_THRESHOLD, createFraudScorer, handlePayment, startFraudDetectionWorker };

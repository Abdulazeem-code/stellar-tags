const crypto = require('crypto');
const { Queue, Worker } = require('bullmq');
const { createRedisConnection } = require('./config/redis');
const { logger } = require('./logger');
const { shouldFallbackToLocalRegistry } = require('./utils');

const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_QUEUE_NAME = 'webhook-deliveries';
const MAX_WEBHOOK_ATTEMPTS = 5;
const WEBHOOK_BACKOFF_DELAY_MS = 1_000;
const WEBHOOK_WORKER_CONCURRENCY = 5;

const WEBHOOK_JOB_OPTIONS = Object.freeze({
  attempts: MAX_WEBHOOK_ATTEMPTS,
  backoff: {
    type: 'exponential',
    delay: WEBHOOK_BACKOFF_DELAY_MS,
  },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
});

let webhookQueue;
let webhookWorker;
let queueConnection;
let workerConnection;

const computeSignature = (secret, rawBody) => {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
};

const webhookEventMatches = (webhook, eventName) => {
  const subscriptions = Array.isArray(webhook?.events) ? webhook.events : ['*'];
  const normalized = subscriptions
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);

  if (normalized.length === 0 || normalized.includes('*')) return true;
  return normalized.includes(eventName);
};

const fetchWebhooksForAddress = async (prisma, poolGetFn, stellarAddress) => {
  try {
    return await prisma.webhook.findMany({
      where: {
        user: { address: stellarAddress },
      },
      select: {
        id: true,
        username: true,
        url: true,
        secret: true,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;

    const rows = await poolGetFn(
      `SELECT w.id, w.username, w.url, w.secret
       FROM webhooks w
       INNER JOIN username_registry u ON u.username = w.username
       WHERE u.address = $1`,
      [stellarAddress],
    );
    return rows || [];
  }
};

const sendWebhook = async (url, payload, secret) => {
  const rawBody = JSON.stringify(payload);
  const signature = computeSignature(secret, rawBody);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Primary header per issue #496 spec.
        'X-Webhook-Signature': signature,
        // Legacy alias kept for backward compatibility.
        'X-Stellar-Tags-Signature': signature,
        'X-Webhook-Timestamp': payload.timestamp,
      },
      body: rawBody,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Webhook responded with HTTP ${response.status}`);
    }
    return { ok: true };
  } finally {
    clearTimeout(timeoutId);
  }
};

const markWebhookSuccess = async (prisma, poolRunFn, webhookId, now) => {
  try {
    await prisma.webhook.update({
      where: { id: webhookId },
      data: { lastSentAt: now, failingSince: null },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    await poolRunFn(
      'UPDATE webhooks SET last_sent_at = ?, failing_since = NULL WHERE id = ?',
      [now.toISOString(), webhookId],
    );
  }
};

const markWebhookFailure = async (prisma, poolRunFn, webhookId, now) => {
  try {
    const current = await prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { failingSince: true },
    });
    await prisma.webhook.update({
      where: { id: webhookId },
      data: {
        lastSentAt: now,
        failingSince: current?.failingSince || now,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    await poolRunFn(
      `UPDATE webhooks
       SET last_sent_at = ?, failing_since = COALESCE(failing_since, ?)
       WHERE id = ?`,
      [now.toISOString(), now.toISOString(), webhookId],
    );
  }
};

const processWebhookJob = async (job, { prisma, poolRunFn }) => {
  const { webhook, payload } = job.data;
  const now = new Date();

  try {
    await sendWebhook(webhook.url, payload, webhook.secret);
  } catch (error) {
    try {
      await markWebhookFailure(prisma, poolRunFn, webhook.id, now);
    } catch (databaseError) {
      logger.error(
        `[webhook-worker] Failed to mark failure for webhook ${webhook.id}: ${databaseError.message}`,
      );
    }
    throw error;
  }

  try {
    await markWebhookSuccess(prisma, poolRunFn, webhook.id, now);
  } catch (databaseError) {
    logger.error(
      `[webhook-worker] Failed to mark success for webhook ${webhook.id}: ${databaseError.message}`,
    );
  }

  logger.info(
    `[webhook-worker] Delivered event=${payload.event_id} webhook=${webhook.id} attempt=${job.attemptsMade + 1}`,
  );
};

const getWebhookQueue = () => {
  if (!webhookQueue) {
    queueConnection = createRedisConnection();
    webhookQueue = new Queue(WEBHOOK_QUEUE_NAME, { connection: queueConnection });
    webhookQueue.on('error', (error) => {
      logger.error(`[webhook-queue] Redis error: ${error.message}`);
    });
  }
  return webhookQueue;
};

const startWebhookWorker = ({ prisma, poolRunFn }) => {
  if (webhookWorker) return webhookWorker;

  workerConnection = createRedisConnection();
  webhookWorker = new Worker(
    WEBHOOK_QUEUE_NAME,
    (job) => processWebhookJob(job, { prisma, poolRunFn }),
    {
      connection: workerConnection,
      concurrency: WEBHOOK_WORKER_CONCURRENCY,
    },
  );

  webhookWorker.on('failed', (job, error) => {
    const maxAttempts = job?.opts?.attempts || MAX_WEBHOOK_ATTEMPTS;
    const attemptsMade = job?.attemptsMade || 1;
    const status = attemptsMade < maxAttempts
      ? `retry scheduled (${attemptsMade}/${maxAttempts})`
      : `retries exhausted (${attemptsMade}/${maxAttempts})`;
    logger.error(
      `[webhook-worker] Delivery failed job=${job?.id || 'unknown'}: ${error.message}; ${status}`,
    );
  });
  webhookWorker.on('error', (error) => {
    logger.error(`[webhook-worker] Redis error: ${error.message}`);
  });

  logger.info(
    `[webhook-worker] Started queue=${WEBHOOK_QUEUE_NAME} concurrency=${WEBHOOK_WORKER_CONCURRENCY}`,
  );
  return webhookWorker;
};

const buildJobId = (webhookId, eventId) => {
  return crypto.createHash('sha256').update(`${webhookId}:${eventId}`).digest('hex');
};

const enqueueWebhookDelivery = async (webhook, payload, queue = getWebhookQueue()) => {
  return queue.add(
    'deliver',
    { webhook, payload },
    {
      ...WEBHOOK_JOB_OPTIONS,
      backoff: { ...WEBHOOK_JOB_OPTIONS.backoff },
      jobId: buildJobId(webhook.id, payload.event_id),
    },
  );
};

const formatAsset = (payment) => {
  if (!payment || payment.asset_type === 'native') return 'native';
  return `${payment.asset_code}:${payment.asset_issuer}`;
};

const dispatchPaymentWebhooks = async ({ prisma, poolGetFn, payment, queue }) => {
  if (!payment || (payment.type !== 'payment' && payment.type_i !== 1)) return;

  const recipientAddress = payment.to;
  if (!recipientAddress) return;

  const webhooks = await fetchWebhooksForAddress(prisma, poolGetFn, recipientAddress);
  if (!webhooks.length) return;

  const payload = {
    event: 'payment.received',
    event_id: `${payment.transaction_hash || ''}-${payment.id || crypto.randomBytes(8).toString('hex')}`,
    timestamp: new Date().toISOString(),
    network: process.env.HORIZON_NETWORK || 'testnet',
    data: {
      transaction_hash: payment.transaction_hash || null,
      from: payment.from || null,
      to: recipientAddress,
      amount: payment.amount || null,
      asset: formatAsset(payment),
      asset_type: payment.asset_type || 'native',
      asset_code: payment.asset_code || null,
      asset_issuer: payment.asset_issuer || null,
      created_at: payment.created_at || null,
      paging_token: payment.paging_token || null,
      metadata: payment.metadata ?? null,
    },
  };

  const deliveryQueue = queue || getWebhookQueue();
  await Promise.all(webhooks.map(async (webhook) => {
    await enqueueWebhookDelivery(webhook, payload, deliveryQueue);
    logger.info(
      `[webhook-queue] Enqueued event=${payload.event_id} webhook=${webhook.id} recipient=${recipientAddress}`,
    );
  }));
};

const closeWebhookQueue = async () => {
  const resources = [webhookWorker, webhookQueue].filter(Boolean);
  await Promise.all(resources.map((resource) => resource.close()));

  const connections = [workerConnection, queueConnection].filter(Boolean);
  await Promise.all(connections.map((connection) => connection.quit()));

  webhookWorker = undefined;
  webhookQueue = undefined;
  workerConnection = undefined;
  queueConnection = undefined;
};

module.exports = {
  dispatchPaymentWebhooks,
  enqueueWebhookDelivery,
  startWebhookWorker,
  closeWebhookQueue,
  processWebhookJob,
  sendWebhook,
  computeSignature,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_QUEUE_NAME,
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_BACKOFF_DELAY_MS,
  WEBHOOK_JOB_OPTIONS,
};

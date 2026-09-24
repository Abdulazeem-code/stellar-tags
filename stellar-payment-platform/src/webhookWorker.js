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
const MAX_RETRY_BACKLOG_DAYS = 3;

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
        events: true,
        failingSince: true,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;

    const rows = await poolGetFn(
      `SELECT w.id, w.username, w.url, w.secret, w.events, w.failing_since
       FROM webhooks w
       INNER JOIN username_registry u ON u.username = w.username
       WHERE u.address = $1`,
      [stellarAddress],
    );
    return (rows || []).map((r) => ({
      id: r.id,
      username: r.username,
      url: r.url,
      secret: r.secret,
      events: Array.isArray(r.events) ? r.events : (typeof r.events === 'string' ? JSON.parse(r.events || '[]') : ['*']),
      failingSince: r.failing_since ? new Date(r.failing_since) : null,
    }));
  }
};

const getWebhooksExhaustedRetries = async (prisma, poolAllFn) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_RETRY_BACKLOG_DAYS);

  try {
    return await prisma.webhook.findMany({
      where: {
        failingSince: { not: null, lt: cutoff },
      },
      select: {
        id: true,
        username: true,
        url: true,
        secret: true,
        failingSince: true,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error) || typeof poolAllFn !== 'function') {
      throw error;
    }
    const rows = await poolAllFn(
      `SELECT id, username, url, secret, failing_since
       FROM webhooks
       WHERE failing_since IS NOT NULL AND failing_since < $1`,
      [cutoff.toISOString()],
    );
    return (rows || []).map((row) => ({
      id: row.id,
      username: row.username,
      url: row.url,
      secret: row.secret,
      failingSince: row.failing_since ? new Date(row.failing_since) : null,
    }));
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
      'UPDATE webhooks SET last_sent_at = $1, failing_since = NULL WHERE id = $2',
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
       SET last_sent_at = $1, failing_since = COALESCE(failing_since, $2)
       WHERE id = $3`,
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

  webhookWorker.on('failed', async (job, error) => {
    const maxAttempts = job?.opts?.attempts || MAX_WEBHOOK_ATTEMPTS;
    const attemptsMade = job?.attemptsMade || 1;
    
    if (attemptsMade >= maxAttempts && job?.data?.webhook) {
      logger.error(`[webhook-worker] Delivery failed job=${job?.id || 'unknown'}: ${error.message}; retries exhausted (${attemptsMade}/${maxAttempts})`);
      try {
        await moveToDLQ(prisma, poolRunFn, job.data.webhook);
      } catch (dlqErr) {
        logger.error(`[webhook-worker] Failed to move webhook ${job.data.webhook.id} to DLQ: ${dlqErr.message}`);
      }
    } else {
      logger.error(`[webhook-worker] Delivery failed job=${job?.id || 'unknown'}: ${error.message}; retry scheduled (${attemptsMade}/${maxAttempts})`);
    }
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
    if (!webhookEventMatches(webhook, payload.event)) {
      logger.info(`[webhook-worker] Skipping webhook id=${webhook.id} url=${webhook.url} for event=${payload.event} due to subscription filter`);
      return;
    }
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

// ── Dead Letter Queue (DLQ) ──────────────────────────────────────────────

/**
 * Move a permanently-failed webhook delivery to the dead-letter queue.
 * The webhook row itself is left intact so the user can re-register if needed;
 * only the delivery record is preserved for manual replay.
 */
const moveToDLQ = async (prisma, poolRunFn, webhook) => {
  const payload = {
    event: 'webhook.delivery_failed',
    event_id: `dlq-${webhook.id}-${crypto.randomBytes(8).toString('hex')}`,
    timestamp: new Date().toISOString(),
    data: {
      webhook_id: webhook.id,
      webhook_url: webhook.url,
      username: webhook.username,
      failing_since: webhook.failingSince ? (webhook.failingSince instanceof Date
        ? webhook.failingSince
        : new Date(webhook.failingSince)
      ).toISOString() : null,
    },
  };

  const now = new Date();
  try {
    await prisma.webhookDLQ.create({
      data: {
        webhookId: webhook.id,
        webhookUrl: webhook.url,
        webhookSecret: webhook.secret,
        username: webhook.username,
        eventType: payload.event,
        eventPayload: JSON.stringify(payload),
        failureReason: `Delivery exhausted after ${MAX_WEBHOOK_ATTEMPTS} attempts`,
        deliveryAttempts: 0,
        movedAt: now,
        replayed: false,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    await poolRunFn(
      `INSERT INTO webhook_dlq
         (id, webhook_id, webhook_url, webhook_secret, username,
          event_type, event_payload, failure_reason, delivery_attempts, moved_at, replayed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, FALSE)`,
      [
        `dlq-${webhook.id}-${crypto.randomBytes(8).toString('hex')}`,
        webhook.id,
        webhook.url,
        webhook.secret,
        webhook.username,
        payload.event,
        JSON.stringify(payload),
        `Delivery exhausted after ${MAX_WEBHOOK_ATTEMPTS} attempts`,
        now.toISOString(),
      ],
    );
  }

  // Clear failingSince on the webhook so it's not repeatedly moved to DLQ.
  // The webhook stays registered; a new payment will retry fresh.
  await markWebhookSuccess(prisma, poolRunFn, webhook.id, now);

  logger.info(
    `[webhook-worker] Moved to DLQ: webhookId=${webhook.id} username=${webhook.username} url=${webhook.url}`,
  );
};

/**
 * List dead-letter-queue entries with optional username filter and pagination.
 */
const listDLQEntries = async (prisma, poolAllFn, opts = {}) => {
  const { username, limit = 50, offset = 0 } = opts;
  try {
    const where = username
      ? { username: { equals: username, mode: 'insensitive' } }
      : {};

    const [entries, total] = await prisma.$transaction([
      prisma.webhookDLQ.findMany({
        where,
        orderBy: { movedAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.webhookDLQ.count({ where }),
    ]);

    return { entries, total };
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    let rows;
    let countRow;
    if (username) {
      rows = await poolAllFn(
        `SELECT * FROM webhook_dlq WHERE username = $1
         ORDER BY moved_at DESC LIMIT $2 OFFSET $3`,
        [username, limit, offset],
      );
      countRow = await poolAllFn(
        'SELECT COUNT(*) AS total FROM webhook_dlq WHERE username = $1',
        [username],
      );
    } else {
      rows = await poolAllFn(
        `SELECT * FROM webhook_dlq ORDER BY moved_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      countRow = await poolAllFn(
        'SELECT COUNT(*) AS total FROM webhook_dlq',
        [],
      );
    }
    return {
      entries: (rows || []).map((r) => ({
        ...r,
        movedAt: r.moved_at ? new Date(r.moved_at) : null,
        replayedAt: r.replayed_at ? new Date(r.replayed_at) : null,
      })),
      total: Number(countRow?.[0]?.total || 0),
    };
  }
};

/**
 * Replay a single DLQ entry.
 */
const replayFromDLQ = async (prisma, poolRunFn, dqlId) => {
  let entry;
  try {
    entry = await prisma.webhookDLQ.findUnique({
      where: { id: dqlId },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    const rows = await poolRunFn(
      'SELECT * FROM webhook_dlq WHERE id = $1 LIMIT 1',
      [dqlId],
    );
    entry = rows?.[0] || null;
  }

  if (!entry) {
    return { ok: false, error: 'DLQ entry not found' };
  }
  if (entry.replayed) {
    return { ok: false, error: 'DLQ entry has already been replayed' };
  }

  const payload = typeof entry.eventPayload === 'string'
    ? JSON.parse(entry.eventPayload)
    : entry.eventPayload;
  const secret = entry.webhookSecret;

  try {
    await sendWebhook(entry.webhookUrl, payload, secret);
    const now = new Date();
    try {
      await prisma.webhookDLQ.update({
        where: { id: dqlId },
        data: { replayed: true, replayedAt: now },
      });
    } catch (err) {
      if (!shouldFallbackToLocalRegistry(err)) throw err;
      await poolRunFn(
        'UPDATE webhook_dlq SET replayed = TRUE, replayed_at = $1 WHERE id = $2',
        [now.toISOString(), dqlId],
      );
    }
    logger.info(`[webhook-worker] DLQ entry ${dqlId} replayed successfully`);
    return { ok: true };
  } catch (err) {
    try {
      await prisma.webhookDLQ.update({
        where: { id: dqlId },
        data: { deliveryAttempts: (entry.deliveryAttempts || 0) + 1 },
      });
    } catch (dbErr) {
      if (!shouldFallbackToLocalRegistry(dbErr)) {
        logger.error(`[webhook-worker] Failed to update DLQ attempt count for ${dqlId}: ${dbErr.message}`);
      } else {
        await poolRunFn(
          'UPDATE webhook_dlq SET delivery_attempts = delivery_attempts + 1 WHERE id = $1',
          [dqlId],
        );
      }
    }
    logger.error(`[webhook-worker] DLQ replay failed for ${dqlId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
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
  MAX_RETRY_BACKLOG_DAYS,
  getWebhooksExhaustedRetries,
  moveToDLQ,
  listDLQEntries,
  replayFromDLQ,
};

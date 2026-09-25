const crypto = require('crypto');
const cron = require('node-cron');
const { logger } = require('./logger');

const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_RETRY_BACKLOG_DAYS = 3;
const RETRY_JOB_CRON = '*/5 * * * *'; // every 5 minutes

const computeSignature = (secret, rawBody) => {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
};

/**
 * Fetches all webhooks associated with a given Stellar address via Prisma.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} stellarAddress
 */
const fetchWebhooksForAddress = async (prisma, stellarAddress) => {
  return prisma.webhook.findMany({
    where: {
      user: { address: stellarAddress },
    },
    select: {
      id: true,
      username: true,
      url: true,
      secret: true,
      failingSince: true,
    },
  });
};

const sendWebhook = async (url, payload, secret) => {
  const rawBody = JSON.stringify(payload);
  const signature = computeSignature(secret, rawBody);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
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
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new Error(`Webhook responded with HTTP ${res.status}`);
    }
    return { ok: true };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
};

/**
 * Marks a webhook delivery as successful in the database.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} webhookId
 * @param {Date} now
 */
const markWebhookSuccess = async (prisma, webhookId, now) => {
  await prisma.webhook.update({
    where: { id: webhookId },
    data: { lastSentAt: now, failingSince: null },
  });
};

/**
 * Marks a webhook delivery as failed in the database, preserving the original
 * `failingSince` timestamp so retry windows stay correct.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} webhookId
 * @param {Date} now
 */
const markWebhookFailure = async (prisma, webhookId, now) => {
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
};

const formatAsset = (payment) => {
  if (!payment) return 'native';
  if (payment.asset_type === 'native') return 'native';
  return `${payment.asset_code}:${payment.asset_issuer}`;
};

/**
 * Dispatches payment webhooks for a given Stellar payment event using only
 * Prisma for all database interactions.
 *
 * @param {{ prisma: import('@prisma/client').PrismaClient, payment: object }} args
 */
const dispatchPaymentWebhooks = async ({
  prisma,
  payment,
}) => {
  if (!payment) return;
  if (payment.type !== 'payment' && payment.type_i !== 1) return;

  const recipientAddress = payment.to;
  if (!recipientAddress) return;

  let webhooks;
  try {
    webhooks = await fetchWebhooksForAddress(prisma, recipientAddress);
  } catch (err) {
    logger.error(`[webhook-worker] Failed to fetch webhooks for ${recipientAddress}:`, err.message);
    return;
  }

  if (!webhooks || webhooks.length === 0) return;

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

  for (const wh of webhooks) {
    const now = new Date();
    try {
      await sendWebhook(wh.url, payload, wh.secret);
      try {
        await markWebhookSuccess(prisma, wh.id, now);
      } catch (dbErr) {
        logger.error(`[webhook-worker] Failed to mark success for webhook ${wh.id}:`, dbErr.message);
      }
      logger.info(`[webhook-worker] Dispatched payment webhook id=${wh.id} url=${wh.url} recipient=${recipientAddress}`);
    } catch (err) {
      try {
        await markWebhookFailure(prisma, wh.id, now);
      } catch (dbErr) {
        logger.error(`[webhook-worker] Failed to mark failure for webhook ${wh.id}:`, dbErr.message);
      }
      logger.error(`[webhook-worker] Webhook delivery failed id=${wh.id} url=${wh.url}:`, err.message);
    }
  }
};

/**
 * Returns all webhooks that have been failing since within the retry backlog
 * window, queried entirely through Prisma.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 */
const listStaleFailingWebhooks = async (prisma) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_RETRY_BACKLOG_DAYS);

  return prisma.webhook.findMany({
    where: {
      failingSince: { not: null, gte: cutoff },
    },
    select: {
      id: true,
      username: true,
      url: true,
      secret: true,
    },
  });
};

/**
 * Sends a liveness ping to a single webhook endpoint.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} webhook
 */
const sendLivenessPing = async (prisma, webhook) => {
  const payload = {
    event: 'webhook.ping',
    event_id: `ping-${crypto.randomBytes(16).toString('hex')}`,
    timestamp: new Date().toISOString(),
    data: { message: 'ping' },
  };
  const now = new Date();
  try {
    await sendWebhook(webhook.url, payload, webhook.secret);
    await markWebhookSuccess(prisma, webhook.id, now);
    return true;
  } catch (err) {
    await markWebhookFailure(prisma, webhook.id, now);
    return false;
  }
};

/**
 * Schedules a recurring cron job that pings stale failing webhooks so they can
 * self-recover once their endpoint is back online.
 *
 * @param {{ prisma: import('@prisma/client').PrismaClient }} options
 */
const scheduleWebhookRetryJob = ({ prisma }) => {
  cron.schedule(RETRY_JOB_CRON, async () => {
    logger.info('[webhook-worker] Running periodic liveness pings for failing webhooks…');
    try {
      const hooks = await listStaleFailingWebhooks(prisma);
      if (hooks.length === 0) return;
      let recovered = 0;
      for (const wh of hooks) {
        const ok = await sendLivenessPing(prisma, wh);
        if (ok) recovered += 1;
      }
      logger.info(
        `[webhook-worker] Liveness pings done. total=${hooks.length}, recovered=${recovered}`,
      );
    } catch (err) {
      logger.error('[webhook-worker] Retry job failed:', err.message);
    }
  });
  logger.info(`[webhook-worker] Retry/liveness job scheduled (cron: ${RETRY_JOB_CRON}).`);
};

module.exports = {
  dispatchPaymentWebhooks,
  scheduleWebhookRetryJob,
  sendWebhook,
  computeSignature,
  WEBHOOK_TIMEOUT_MS,
};

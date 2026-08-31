const crypto = require('crypto');
const cron = require('node-cron');
const { logger } = require('./logger');
const { shouldFallbackToLocalRegistry } = require('./utils');

const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_RETRY_BACKLOG_DAYS = 3;
const RETRY_JOB_CRON = '*/5 * * * *'; // every 5 minutes

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

const markWebhookSuccess = async (prisma, poolRunFn, webhookId, now) => {
  try {
    await prisma.webhook.update({
      where: { id: webhookId },
      data: { lastSentAt: now, failingSince: null },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    await poolRunFn(
      `UPDATE webhooks SET last_sent_at = $1, failing_since = NULL WHERE id = $2`,
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
       SET last_sent_at = $1,
           failing_since = COALESCE(failing_since, $2)
       WHERE id = $3`,
      [now.toISOString(), now.toISOString(), webhookId],
    );
  }
};

const formatAsset = (payment) => {
  if (!payment) return 'native';
  if (payment.asset_type === 'native') return 'native';
  return `${payment.asset_code}:${payment.asset_issuer}`;
};

const dispatchPaymentWebhooks = async ({
  prisma,
  poolGetFn,
  poolRunFn,
  payment,
}) => {
  if (!payment) return;
  if (payment.type !== 'payment' && payment.type_i !== 1) return;

  const recipientAddress = payment.to;
  if (!recipientAddress) return;

  let webhooks;
  try {
    webhooks = await fetchWebhooksForAddress(prisma, poolGetFn, recipientAddress);
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
    if (!webhookEventMatches(wh, payload.event)) {
      logger.info(`[webhook-worker] Skipping webhook id=${wh.id} url=${wh.url} for event=${payload.event} due to subscription filter`);
      continue;
    }

    const now = new Date();
    try {
      await sendWebhook(wh.url, payload, wh.secret);
      try {
        await markWebhookSuccess(prisma, poolRunFn, wh.id, now);
      } catch (dbErr) {
        logger.error(`[webhook-worker] Failed to mark success for webhook ${wh.id}:`, dbErr.message);
      }
      logger.info(`[webhook-worker] Dispatched payment webhook id=${wh.id} url=${wh.url} recipient=${recipientAddress}`);
    } catch (err) {
      try {
        await markWebhookFailure(prisma, poolRunFn, wh.id, now);
      } catch (dbErr) {
        logger.error(`[webhook-worker] Failed to mark failure for webhook ${wh.id}:`, dbErr.message);
      }
      logger.error(`[webhook-worker] Webhook delivery failed id=${wh.id} url=${wh.url}:`, err.message);
    }
  }
};

const listStaleFailingWebhooks = async (prisma, poolAllFn) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_RETRY_BACKLOG_DAYS);
  try {
    return await prisma.webhook.findMany({
      where: {
        failingSince: { not: null, gte: cutoff },
      },
      select: {
        id: true,
        username: true,
        url: true,
        secret: true,
       events: true,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    const rows = await poolAllFn(
      `SELECT id, username, url, secret, events FROM webhooks
       WHERE failing_since IS NOT NULL AND failing_since >= $1`,
      [cutoff.toISOString()],
    );
    return (rows || []).map((r) => ({
      id: r.id,
      username: r.username,
      url: r.url,
      secret: r.secret,
      events: Array.isArray(r.events) ? r.events : (typeof r.events === 'string' ? JSON.parse(r.events || '[]') : ['*']),
    }));
  }
};

const sendLivenessPing = async (prisma, poolRunFn, webhook) => {
  if (!webhookEventMatches(webhook, 'webhook.ping')) {
    return false;
  }

  const payload = {
    event: 'webhook.ping',
    event_id: `ping-${crypto.randomBytes(16).toString('hex')}`,
    timestamp: new Date().toISOString(),
    data: { message: 'ping' },
  };
  const now = new Date();
  try {
    await sendWebhook(webhook.url, payload, webhook.secret);
    await markWebhookSuccess(prisma, poolRunFn, webhook.id, now);
    return true;
  } catch (err) {
    await markWebhookFailure(prisma, poolRunFn, webhook.id, now);
    return false;
  }
};

// ── Dead Letter Queue (DLQ) ──────────────────────────────────────────────

/**
 * Return webhooks whose failingSince is older than MAX_RETRY_BACKLOG_DAYS —
 * their retry window has expired and they should be moved to the DLQ for
 * manual intervention.
 */
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
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    const rows = await poolAllFn(
      `SELECT id, username, url, secret, failing_since
       FROM webhooks
       WHERE failing_since IS NOT NULL AND failing_since < ?`,
      [cutoff.toISOString()],
    );
    return (rows || []).map((r) => ({
      id: r.id,
      username: r.username,
      url: r.url,
      secret: r.secret,
      failingSince: r.failing_since ? new Date(r.failing_since) : null,
    }));
  }
};

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
      failing_since: (webhook.failingSince instanceof Date
        ? webhook.failingSince
        : new Date(webhook.failingSince)
      ).toISOString(),
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
        failureReason: `Delivery exhausted after ${MAX_RETRY_BACKLOG_DAYS} days of failing`,
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)`,
      [
        `dlq-${webhook.id}-${crypto.randomBytes(8).toString('hex')}`,
        webhook.id,
        webhook.url,
        webhook.secret,
        webhook.username,
        payload.event,
        JSON.stringify(payload),
        `Delivery exhausted after ${MAX_RETRY_BACKLOG_DAYS} days of failing`,
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
 *
 * @param {object} prisma
 * @param {object} poolAllFn
 * @param {object} [opts]
 * @param {string} [opts.username] - Filter by username
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @returns {Promise<{entries: Array, total: number}>}
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
        `SELECT * FROM webhook_dlq WHERE username = ?
         ORDER BY moved_at DESC LIMIT ? OFFSET ?`,
        [username, limit, offset],
      );
      countRow = await poolAllFn(
        'SELECT COUNT(*) AS total FROM webhook_dlq WHERE username = ?',
        [username],
      );
    } else {
      rows = await poolAllFn(
        `SELECT * FROM webhook_dlq ORDER BY moved_at DESC LIMIT ? OFFSET ?`,
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
 * Replay a single DLQ entry: attempt to deliver its stored payload to the
 * webhook URL one more time. On success, marks the entry as replayed; on
 * failure, increments the delivery attempt counter and leaves it in the DLQ.
 *
 * @returns {Promise<{ok: boolean, statusCode?: number, error?: string}>}
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
      'SELECT * FROM webhook_dlq WHERE id = ? LIMIT 1',
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
        'UPDATE webhook_dlq SET replayed = 1, replayed_at = ? WHERE id = ?',
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
        logger.error(`[webhook-worker] Failed to update DLQ attempt count for ${dqlId}:`, dbErr.message);
      } else {
        await poolRunFn(
          'UPDATE webhook_dlq SET delivery_attempts = delivery_attempts + 1 WHERE id = ?',
          [dqlId],
        );
      }
    }
    logger.error(`[webhook-worker] DLQ replay failed for ${dqlId}:`, err.message);
    return { ok: false, error: err.message };
  }
};

const scheduleWebhookRetryJob = ({ prisma, poolAllFn, poolRunFn }) => {
  cron.schedule(RETRY_JOB_CRON, async () => {
    logger.info('[webhook-worker] Running periodic liveness pings for failing webhooks…');
    try {
      const hooks = await listStaleFailingWebhooks(prisma, poolAllFn);
      if (hooks.length === 0) {
        // Check for exhausted webhooks to move to DLQ even when no stale hooks
        const exhausted = await getWebhooksExhaustedRetries(prisma, poolAllFn);
        if (exhausted.length > 0) {
          for (const wh of exhausted) {
            try {
              await moveToDLQ(prisma, poolRunFn, wh);
            } catch (dlqErr) {
              logger.error(`[webhook-worker] Failed to move webhook ${wh.id} to DLQ:`, dlqErr.message);
            }
          }
          logger.info(
            `[webhook-worker] Moved ${exhausted.length} exhausted webhooks to DLQ`,
          );
        }
        return;
      }
      let recovered = 0;
      let moved = 0;
      for (const wh of hooks) {
        const ok = await sendLivenessPing(prisma, poolRunFn, wh);
        if (ok) {
          recovered += 1;
        } else if (
          wh.failingSince &&
          (new Date() - new Date(wh.failingSince)) / (1000 * 60 * 60 * 24) >=
            MAX_RETRY_BACKLOG_DAYS
        ) {
          // Liveness ping failed and the webhook is past its retry window.
          try {
            await moveToDLQ(prisma, poolRunFn, wh);
            moved += 1;
          } catch (dlqErr) {
            logger.error(`[webhook-worker] Failed to move webhook ${wh.id} to DLQ:`, dlqErr.message);
          }
        }
      }
      logger.info(
        `[webhook-worker] Liveness pings done. total=${hooks.length}, recovered=${recovered}, movedToDLQ=${moved}`,
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
  moveToDLQ,
  getWebhooksExhaustedRetries,
  listDLQEntries,
  replayFromDLQ,
};

const fs = require('fs');

const file = 'src/webhookWorker.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Remove shouldFallbackToLocalRegistry
content = content.replace(
  "const { shouldFallbackToLocalRegistry } = require('./utils');\n",
  ""
);

// 2. fetchWebhooksForAddress
content = content.replace(
  /const fetchWebhooksForAddress = async \(prisma, poolGetFn, stellarAddress\) => \{[\s\S]*?^\};/m,
`const fetchWebhooksForAddress = async (prisma, stellarAddress) => {
  return prisma.webhook.findMany({
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
};`
);

// 3. getWebhooksExhaustedRetries
content = content.replace(
  /const getWebhooksExhaustedRetries = async \(prisma, poolAllFn\) => \{[\s\S]*?^\};/m,
`const getWebhooksExhaustedRetries = async (prisma) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_RETRY_BACKLOG_DAYS);

  return prisma.webhook.findMany({
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
};`
);

// 4. markWebhookSuccess
content = content.replace(
  /const markWebhookSuccess = async \(prisma, poolRunFn, webhookId, now\) => \{[\s\S]*?^\};/m,
`const markWebhookSuccess = async (prisma, webhookId, now) => {
  await prisma.webhook.update({
    where: { id: webhookId },
    data: { lastSentAt: now, failingSince: null },
  });
};`
);

// 5. markWebhookFailure
content = content.replace(
  /const markWebhookFailure = async \(prisma, poolRunFn, webhookId, now\) => \{[\s\S]*?^\};/m,
`const markWebhookFailure = async (prisma, webhookId, now) => {
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
};`
);

// 6. processWebhookJob
content = content.replace(
  /const processWebhookJob = async \(job, \{ prisma, poolRunFn \}\) => \{/g,
  "const processWebhookJob = async (job, { prisma }) => {"
);
content = content.replace(/markWebhookFailure\(prisma, poolRunFn, /g, "markWebhookFailure(prisma, ");
content = content.replace(/markWebhookSuccess\(prisma, poolRunFn, /g, "markWebhookSuccess(prisma, ");

// 7. startWebhookWorker
content = content.replace(
  /const startWebhookWorker = \(\{ prisma, poolRunFn \}\) => \{/g,
  "const startWebhookWorker = ({ prisma }) => {"
);
content = content.replace(
  /\(job\) => processWebhookJob\(job, \{ prisma, poolRunFn \}\),/g,
  "(job) => processWebhookJob(job, { prisma }),"
);
content = content.replace(
  /await moveToDLQ\(prisma, poolRunFn, job\.data\.webhook\);/g,
  "await moveToDLQ(prisma, job.data.webhook);"
);

// 8. dispatchPaymentWebhooks
content = content.replace(
  /const dispatchPaymentWebhooks = async \(\{ prisma, poolGetFn, payment, queue \}\) => \{/g,
  "const dispatchPaymentWebhooks = async ({ prisma, payment, queue }) => {"
);
content = content.replace(
  /await fetchWebhooksForAddress\(prisma, poolGetFn, recipientAddress\);/g,
  "await fetchWebhooksForAddress(prisma, recipientAddress);"
);

// 9. moveToDLQ
content = content.replace(
  /const moveToDLQ = async \(prisma, poolRunFn, webhook\) => \{[\s\S]*?^\};/m,
`const moveToDLQ = async (prisma, webhook) => {
  const payload = {
    event: 'webhook.delivery_failed',
    event_id: \`dlq-\${webhook.id}-\${crypto.randomBytes(8).toString('hex')}\`,
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
  await prisma.webhookDLQ.create({
    data: {
      webhookId: webhook.id,
      webhookUrl: webhook.url,
      webhookSecret: webhook.secret,
      username: webhook.username,
      eventType: payload.event,
      eventPayload: JSON.stringify(payload),
      failureReason: \`Delivery exhausted after \${MAX_WEBHOOK_ATTEMPTS} attempts\`,
      deliveryAttempts: 0,
      movedAt: now,
      replayed: false,
    },
  });

  // Clear failingSince on the webhook so it's not repeatedly moved to DLQ.
  // The webhook stays registered; a new payment will retry fresh.
  await markWebhookSuccess(prisma, webhook.id, now);

  logger.info(
    \`[webhook-worker] Moved to DLQ: webhookId=\${webhook.id} username=\${webhook.username} url=\${webhook.url}\`,
  );
};`
);

// 10. listDLQEntries
content = content.replace(
  /const listDLQEntries = async \(prisma, poolAllFn, opts = \{\}\) => \{[\s\S]*?^\};/m,
`const listDLQEntries = async (prisma, opts = {}) => {
  const { username, limit = 50, offset = 0 } = opts;
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
};`
);

// 11. replayFromDLQ
content = content.replace(
  /const replayFromDLQ = async \(prisma, poolRunFn, dqlId\) => \{[\s\S]*?^\};/m,
`const replayFromDLQ = async (prisma, dqlId) => {
  const entry = await prisma.webhookDLQ.findUnique({
    where: { id: dqlId },
  });

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
    await prisma.webhookDLQ.update({
      where: { id: dqlId },
      data: { replayed: true, replayedAt: now },
    });
    logger.info(\`[webhook-worker] DLQ entry \${dqlId} replayed successfully\`);
    return { ok: true };
  } catch (err) {
    try {
      await prisma.webhookDLQ.update({
        where: { id: dqlId },
        data: { deliveryAttempts: (entry.deliveryAttempts || 0) + 1 },
      });
    } catch (dbErr) {
      logger.error(\`[webhook-worker] Failed to update DLQ attempt count for \${dqlId}: \${dbErr.message}\`);
    }
    logger.error(\`[webhook-worker] DLQ replay failed for \${dqlId}: \${err.message}\`);
    return { ok: false, error: err.message };
  }
};`
);

fs.writeFileSync(file, content, 'utf8');
console.log('Migration of webhookWorker.js completed');

// SSE Horizon Listener for Real-Time Payment Detection

const { prisma } = require('./prismaClient');
const { logger } = require('./src/logger');
const { createRedisConnection } = require('./src/config/redis');
const { PAYMENT_STREAM } = require('./src/fraudDetection');
const {
  dispatchPaymentWebhooks,
  dispatchPaymentRequestWebhooks,
  startWebhookWorker,
  scheduleWebhookRetryJob,
  closeWebhookQueue,
} = require('./src/webhookWorker');
const {
  horizon,
  createBreaker,
} = require('./src/services/stellarService');
const { publishPaymentUpdate, emitPaymentUpdate } = require('./src/sse');
const { createPaymentWithOutbox } = require('./src/services/settlementOutbox');
const { matchPayment } = require('./src/services/paymentRequestMatcher');
const { notifyPaymentRequestUpdate } = require('./src/sse/paymentRequestEvents');


const NETWORK = process.env.HORIZON_NETWORK || 'testnet';

const HORIZON_URLS = {
  testnet: 'https://horizon-testnet.stellar.org',
  public: 'https://horizon.stellar.org',
};

const HORIZON_URL = HORIZON_URLS[NETWORK] || HORIZON_URLS.testnet;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 60000;

// Webhook delivery runs on BullMQ, which needs Redis. Without it the worker
// would retry a connection to 127.0.0.1:6379 forever, so webhooks are skipped
// (with a warning) and only status updates are sent. Read at call time so a
// process can be configured after this module loads.
const webhooksEnabled = () =>
  Boolean(process.env.REDIS_URL || process.env.REDIS_CLUSTER_NODES);

// Dedicated ioredis publisher for cross-process SSE payment events.
// When REDIS_URL is absent real-time updates are silently disabled.
const redisPublisher = process.env.REDIS_URL ? createRedisConnection() : null;
if (redisPublisher) {
  redisPublisher.on('error', (err) =>
    logger.error({ err }, '[listener] Redis publisher error'),
  );
} else {
  logger.warn(
    '[listener] REDIS_URL not set: SSE payment updates only reach clients of this process (in-process mode).',
  );
}

const healthCheckBreaker = createBreaker(
  // Newest ledger. (The SDK has no ledgers().latest(); calling it threw on
  // every sync, so the listener never watched a single account.)
  () => horizon.ledgers().order('desc').limit(1).call(),
  { timeout: 5000, volumeThreshold: 3 },
);


const activeStreams = new Map();
const fraudStream = process.env.REDIS_URL ? createRedisConnection() : null;
// Handle for the periodic account-sync timer, kept so shutdown can clear it.
let syncInterval = null;
// Guards against overlapping syncs opening duplicate streams when one cycle
// takes longer than the poll interval.
let isSyncing = false;


const timestamp = () => new Date().toISOString();

const formatPayment = (payment, trackedAccount) => {
  const direction = payment.to === trackedAccount ? 'INCOMING' : 'OUTGOING';
  const asset =
    payment.asset_type === 'native'
      ? 'XLM'
      : `${payment.asset_code}:${payment.asset_issuer}`;

  return [
    `[${timestamp()}] 💸 ${direction} PAYMENT DETECTED`,
    `  Account:     ${trackedAccount}`,
    `  From:        ${payment.from}`,
    `  To:          ${payment.to}`,
    `  Amount:      ${payment.amount} ${asset}`,
    `  Tx Hash:     ${payment.transaction_hash}`,
    `  Created:     ${payment.created_at}`,
    '  ─────────────────────────────────────────',
  ].join('\n');
};



// ---------------------------------------------------------------------------
// Stream Management
// ---------------------------------------------------------------------------

// Open a payment SSE stream for a single Stellar account.
const watchAccount = (accountId) => {
  if (activeStreams.has(accountId)) {
    return; // Already watching
  }

  logger.info(`[${timestamp()}] 👁️  Watching payments for ${accountId}`);

  let closeStream = null;
  let closed = false;


  const stopStream = () => {
    if (closed) return;
    closed = true;
    activeStreams.delete(accountId);
    if (typeof closeStream === 'function') {
      try {
        closeStream();
      } catch (err) {
        logger.error(
          `[${timestamp()}] Failed to close stream for ${accountId}:`,
          err?.message || err,
        );
      }
    }
  };

  closeStream = horizon
    .payments()
    .forAccount(accountId)
    .cursor('now')
    .stream({
      onmessage: (payment) => {
        if (payment.type === 'payment' || payment.type_i === 1) {
          logger.info(formatPayment(payment, accountId));
          matchPayment(prisma, payment, {
            onPaid: (request, { amountPaid }) => Promise.all([
              webhooksEnabled()
                ? dispatchPaymentRequestWebhooks({ prisma, request, status: 'paid', amountPaid })
                : null,
              notifyPaymentRequestUpdate({
                redisPublisher,
                requestId: request.id,
                status: 'paid',
                transactionHash: request.transactionHash,
                paidAt: request.paidAt,
              }),
            ]),
          }).catch((err) =>
            logger.error({ err }, '[listener] Payment request matcher failed'),
          );
          createPaymentWithOutbox(prisma, {
            transactionHash: payment.transaction_hash,
            fromAddress: payment.from,
            toAddress: payment.to,
            amount: parseFloat(payment.amount),
            assetCode: payment.asset_type === 'native' ? 'XLM' : payment.asset_code,
            status: 'completed'
          }).then((created) => {
            const update = {
              status: created.status,
              transactionHash: created.transactionHash,
              fromAddress: created.fromAddress,
              toAddress: created.toAddress,
              amount: created.amount,
              assetCode: created.assetCode,
              detectedAt: created.createdAt,
            };
            // Without Redis the listener can only reach streams in its own
            // process, which is the API when it runs in-process.
            if (!redisPublisher) {
              emitPaymentUpdate(created.id, update);
              return undefined;
            }
            // Fan the new payment out to connected SSE clients via Redis, so
            // every API process can stream the status update (#730).
            return publishPaymentUpdate(redisPublisher, created.id, update).catch((publishErr) =>
              logger.error({ err: publishErr }, 'Failed to publish payment status update'),
            );
          }).catch(err => logger.error({ err }, 'Failed to insert payment to DB'));
        }
      },
      onerror: (error) => {
        logger.error(
          `[${timestamp()}] ⚠️  Stream error for ${accountId}:`,
          error?.message || error,
        );
        // Release dead stream before removing map entry
        stopStream();
        logger.info(
          `[${timestamp()}] 🔄 Removed dead stream for ${accountId}; will reconnect on next sync`,
        );
      },
    });

  if (closed) {
    // Close synchronously-errored stream
    if (typeof closeStream === 'function') {
      try {
        closeStream();
      } catch (err) {
        logger.error(
          `[${timestamp()}] Failed to close stream for ${accountId}:`,
          err?.message || err,
        );
      }
    }
    return;
  }

  activeStreams.set(accountId, stopStream);
};

// Query the local database for all registered public keys and open streams for any that aren't already being watched.
const syncWatchedAccounts = async () => {
  if (isSyncing) return;
  isSyncing = true;

  try {

    try {
      await healthCheckBreaker.fire();
    } catch {
      logger.warn(
        `[${timestamp()}] ⏸️  Horizon health check failed; skipping stream sync`,
      );
      return;
    }

    try {
      const rows = await prisma.user.findMany({
        distinct: ['address'],
        select: { address: true },
      });

      const currentAddresses = new Set(rows.map((r) => r.address));

      // Start watching new accounts
      for (const { address } of rows) {
        if (!activeStreams.has(address)) {
          watchAccount(address);
        }
      }

      // Stop watching removed accounts
      for (const [address, stopFn] of activeStreams) {
        if (!currentAddresses.has(address)) {
          logger.info(`[${timestamp()}] 🛑 Stopped watching removed account ${address}`);
          if (typeof stopFn === 'function') {
            stopFn();
          } else {
            activeStreams.delete(address);
          }
        }
      }

      logger.info(
        `[${timestamp()}] 📡 Actively monitoring ${activeStreams.size} account(s)`,
      );
    } catch (err) {
      logger.error(`[${timestamp()}] ❌ Failed to sync watched accounts:`, err.message);
    }
  } finally {
    isSyncing = false;
  }
};


// Closes streams, timers and queues but leaves Prisma and the process alone,
// so the API can stop an in-process listener as part of its own shutdown.
const stop = async () => {
  logger.info(`[${timestamp()}] Stopping Horizon listener...`);

  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }

  for (const [address, stopFn] of activeStreams) {
    if (typeof stopFn === 'function') {
      stopFn();
    } else {
      activeStreams.delete(address);
    }
    logger.info(`  Closed stream for ${address}`);
  }
  activeStreams.clear();
  await closeWebhookQueue();
  if (redisPublisher) {
    try {
      await redisPublisher.quit();
    } catch (err) {
      logger.error({ err }, '[listener] Error closing Redis publisher during shutdown');
    }
  }
  if (fraudStream) await fraudStream.quit();
};

// Standalone process shutdown (npm run listener).
const shutdown = async () => {
  await stop();
  await prisma.$disconnect();
  process.exit(0);
};


const main = async () => {
  logger.info('═══════════════════════════════════════════════════════');
  logger.info('  Stellar Horizon Payment Listener');
  logger.info(`  Network:  ${NETWORK.toUpperCase()}`);
  logger.info(`  Horizon:  ${HORIZON_URL}`);
  logger.info(`  Poll:     every ${POLL_INTERVAL_MS / 1000}s for new accounts`);
  logger.info('═══════════════════════════════════════════════════════');

  // Initial sync
  await syncWatchedAccounts();

  if (webhooksEnabled()) {
    // Deliver queued webhooks (payment.received and payment_request.*). The API
    // process only enqueues, so without a worker nothing is ever sent.
    try {
      startWebhookWorker({ prisma });
    } catch (err) {
      logger.error('Failed to start webhook worker:', err.message);
    }

    // Schedule webhook retry / liveness pings
    try {
      scheduleWebhookRetryJob({ prisma });
    } catch (err) {
      logger.error('Failed to schedule webhook retry job:', err.message);
    }
  } else {
    logger.warn(
      '[listener] Redis is not configured (REDIS_URL / REDIS_CLUSTER_NODES): webhooks will not be delivered. Payment matching and status updates still run.',
    );
  }

  // Periodically check for newly registered accounts.
  syncInterval = setInterval(syncWatchedAccounts, POLL_INTERVAL_MS);
  if (syncInterval && typeof syncInterval.unref === 'function') {
    syncInterval.unref();
  }

  return { syncInterval };
};


if (require.main === module) {
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  main().catch((err) => {
    logger.error('Fatal error starting Horizon listener:', err);
    process.exit(1);
  });
}

module.exports = {
  watchAccount,
  syncWatchedAccounts,
  stop,
  shutdown,
  main,
  activeStreams,
};

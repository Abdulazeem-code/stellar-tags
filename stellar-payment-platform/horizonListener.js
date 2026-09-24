// ---------------------------------------------------------------------------
// #52 — SSE Horizon Listener for Real-Time Payment Detection
// ---------------------------------------------------------------------------
// This background service connects to the Stellar Horizon network using
// Server-Sent Events (SSE) to monitor incoming payments for all public keys
// registered in the local federation database.
//
// Usage:
//   npm run listener                  (testnet, default)
//   HORIZON_NETWORK=public npm run listener  (mainnet)
// ---------------------------------------------------------------------------

const { prisma } = require('./prismaClient');
const { logger } = require('./src/logger');
const { poolGet, poolRun } = require('./src/db');
const {
  dispatchPaymentWebhooks,
  startWebhookWorker,
  closeWebhookQueue,
} = require('./src/webhookWorker');
const {
  horizon,
  createBreaker,
} = require('./src/services/stellarService');
const { createRedisConnection } = require('./src/config/redis');
const { publishPaymentUpdate } = require('./src/websocket');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const NETWORK = process.env.HORIZON_NETWORK || 'testnet';

const HORIZON_URLS = {
  testnet: 'https://horizon-testnet.stellar.org',
  public: 'https://horizon.stellar.org',
};

const HORIZON_URL = HORIZON_URLS[NETWORK] || HORIZON_URLS.testnet;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 60000;

// ---------------------------------------------------------------------------
// Redis publisher for real-time WebSocket events
// ---------------------------------------------------------------------------
// When a payment is detected on-chain we publish a message to the Redis
// channel `stellar:payment:update`. The API server process subscribes to that
// channel (via src/websocket/index.js) and broadcasts the event to every
// browser client currently watching the affected payment intent ID.
//
// A dedicated ioredis connection is used for publishing so the BullMQ
// worker connections (which require maxRetriesPerRequest: null) are unaffected.
const redisPublisher = process.env.REDIS_URL ? createRedisConnection() : null;
if (redisPublisher) {
  redisPublisher.on('error', (err) =>
    logger.error({ err }, '[listener] Redis publisher error'),
  );
} else {
  logger.warn(
    '[listener] REDIS_URL not set — real-time WebSocket payment updates are disabled.',
  );
}

// ---------------------------------------------------------------------------
// Horizon Health-Check Circuit Breaker
// ---------------------------------------------------------------------------
// Wraps a lightweight Horizon query so we can detect outages fast and avoid
// opening new streams (or polling the DB) while Horizon is unreachable.
const healthCheckBreaker = createBreaker(
  () => horizon.ledgers().latest().call(),
  { timeout: 5000, volumeThreshold: 3 },
);

// ---------------------------------------------------------------------------
// Stream Management
// ---------------------------------------------------------------------------
const activeStreams = new Map();

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------
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

/**
 * Resolve any pending PaymentIntent records that match the on-chain payment
 * and broadcast a real-time status update via Redis → Socket.io.
 *
 * A PaymentIntent is considered a match when:
 *   - its `to` address equals the payment's destination, and
 *   - its `status` is still "pending".
 *
 * On a match we mark the intent as "completed" and publish the event so the
 * API server can notify subscribed browser clients over the WebSocket channel.
 *
 * @param {object} payment         - The Horizon payment operation object.
 * @param {string} trackedAccount  - The local address that was being watched.
 */
const notifyPaymentIntents = async (payment, trackedAccount) => {
  if (!redisPublisher) return; // Real-time updates not configured

  try {
    // Find pending intents addressed to this account. There may be several
    // (e.g. multiple outstanding invoices for the same recipient).
    const matchingIntents = await prisma.paymentIntent.findMany({
      where: {
        to: trackedAccount,
        status: 'pending',
      },
      select: { id: true },
    });

    if (matchingIntents.length === 0) return;

    // Update all matched intents to "completed" in one atomic batch.
    await prisma.paymentIntent.updateMany({
      where: {
        id: { in: matchingIntents.map((i) => i.id) },
        status: 'pending', // guard against concurrent updates
      },
      data: { status: 'completed' },
    });

    // Broadcast a real-time update for each resolved intent.
    const updatePayload = {
      status: 'completed',
      transactionHash: payment.transaction_hash,
      from: payment.from,
      to: payment.to,
      amount: payment.amount,
      asset:
        payment.asset_type === 'native'
          ? 'XLM'
          : `${payment.asset_code}:${payment.asset_issuer}`,
      detectedAt: new Date().toISOString(),
    };

    await Promise.all(
      matchingIntents.map((intent) =>
        publishPaymentUpdate(redisPublisher, intent.id, updatePayload),
      ),
    );

    logger.info(
      {
        count: matchingIntents.length,
        transactionHash: payment.transaction_hash,
        to: trackedAccount,
      },
      '[listener] Published payment:update for matching PaymentIntent(s)',
    );
  } catch (err) {
    logger.error(
      { err: err.message, transactionHash: payment.transaction_hash },
      '[listener] Failed to notify PaymentIntent(s) via WebSocket',
    );
  }
};

/**
 * Open a payment SSE stream for a single Stellar account.
 * On error the stream is removed from the active map so the next sync cycle
 * can attempt to reconnect it (instead of staying stuck on a dead stream).
 */
const watchAccount = (accountId) => {
  if (activeStreams.has(accountId)) {
    return; // Already watching
  }

  logger.info(`[${timestamp()}] 👁️  Watching payments for ${accountId}`);

  const closeStream = horizon
    .payments()
    .forAccount(accountId)
    .cursor('now')
    .stream({
      onmessage: (payment) => {
        if (payment.type === 'payment' || payment.type_i === 1) {
          logger.info(formatPayment(payment, accountId));
          dispatchPaymentWebhooks({
            prisma,
            poolGetFn: poolGet,
            poolRunFn: poolRun,
            payment,
          }).catch((err) =>
            logger.error(
              `[${timestamp()}] ⚠️  Webhook dispatch failed for tx ${payment.transaction_hash}:`,
              err?.message || err,
            ),
          );
          // Emit a real-time WebSocket update for any pending PaymentIntent
          // records addressed to this account.
          notifyPaymentIntents(payment, accountId).catch((err) =>
            logger.error(
              `[${timestamp()}] ⚠️  WebSocket notification failed for tx ${payment.transaction_hash}:`,
              err?.message || err,
            ),
          );
        }
      },
      onerror: (error) => {
        logger.error(
          `[${timestamp()}] ⚠️  Stream error for ${accountId}:`,
          error?.message || error,
        );
        // Remove the dead stream so syncWatchedAccounts can re-open it on the
        // next poll cycle instead of leaving a stale entry in the map.
        activeStreams.delete(accountId);
        logger.info(
          `[${timestamp()}] 🔄 Removed dead stream for ${accountId}; will reconnect on next sync`,
        );
      },
    });

  activeStreams.set(accountId, closeStream);
};

/**
 * Query the local database for all registered public keys and open
 * streams for any that aren't already being watched.
 */
const syncWatchedAccounts = async () => {
  // Fast-fail when Horizon is known to be down — don't waste resources
  // opening streams that will immediately error.
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
    for (const [address, closeFn] of activeStreams) {
      if (!currentAddresses.has(address)) {
        logger.info(`[${timestamp()}] 🛑 Stopped watching removed account ${address}`);
        if (typeof closeFn === 'function') closeFn();
        activeStreams.delete(address);
      }
    }

    logger.info(
      `[${timestamp()}] 📡 Actively monitoring ${activeStreams.size} account(s)`,
    );
  } catch (err) {
    logger.error(`[${timestamp()}] ❌ Failed to sync watched accounts:`, err.message);
  }
};

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------
const shutdown = async () => {
  logger.info(`\n[${timestamp()}] Shutting down Horizon listener...`);
  for (const [address, closeFn] of activeStreams) {
    if (typeof closeFn === 'function') closeFn();
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
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const main = async () => {
  logger.info('═══════════════════════════════════════════════════════');
  logger.info('  Stellar Horizon Payment Listener');
  logger.info(`  Network:  ${NETWORK.toUpperCase()}`);
  logger.info(`  Horizon:  ${HORIZON_URL}`);
  logger.info(`  Poll:     every ${POLL_INTERVAL_MS / 1000}s for new accounts`);
  logger.info('═══════════════════════════════════════════════════════');

  // Initial sync
  await syncWatchedAccounts();

  // Start the durable Redis-backed webhook delivery worker.
  startWebhookWorker({ prisma, poolRunFn: poolRun });

  // Periodically check for newly registered accounts
  setInterval(syncWatchedAccounts, POLL_INTERVAL_MS);
};

main().catch((err) => {
  logger.error('Fatal error starting Horizon listener:', err);
  process.exit(1);
});

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
const { createRedisConnection } = require('./src/config/redis');
const { PAYMENT_STREAM } = require('./src/fraudDetection');
const {
  dispatchPaymentWebhooks,
  scheduleWebhookRetryJob,
} = require('./src/webhookWorker');
const {
  horizon,
  createBreaker,
} = require('./src/services/stellarService');

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
const fraudStream = process.env.REDIS_URL ? createRedisConnection() : null;
// Handle for the periodic account-sync timer, kept so shutdown can clear it.
let syncInterval = null;
// Guards against overlapping syncs opening duplicate streams when one cycle
// takes longer than the poll interval.
let isSyncing = false;

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

const publishPaymentForFraudDetection = async (payment) => {
  if (!fraudStream) return;
  const payload = { ...payment, event_id: payment.transaction_hash || payment.paging_token };
  await fraudStream.xadd(PAYMENT_STREAM, '*', 'payload', JSON.stringify(payload));
};

// ---------------------------------------------------------------------------
// Stream Management
// ---------------------------------------------------------------------------

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

  let closeStream = null;
  let closed = false;

  // Idempotent teardown for a single account stream. Closing the SDK stream is
  // essential: it owns a reconnect timer plus an EventSource/socket that keep
  // running (and retaining their closures) until the returned close function is
  // invoked. Dropping the map entry alone leaked both (#683).
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
          publishPaymentForFraudDetection(payment).catch((err) =>
            logger.error({ err, transactionHash: payment.transaction_hash }, 'Failed to publish payment to fraud stream'),
          );
          dispatchPaymentWebhooks({
            prisma,
            payment,
          }).catch((err) =>
            logger.error(
              `[${timestamp()}] ⚠️  Webhook dispatch failed for tx ${payment.transaction_hash}:`,
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
        // Release the dead stream (socket + reconnect timer) before removing
        // the map entry, so syncWatchedAccounts can re-open a fresh one next
        // poll cycle without leaking the old connection.
        stopStream();
        logger.info(
          `[${timestamp()}] 🔄 Removed dead stream for ${accountId}; will reconnect on next sync`,
        );
      },
    });

  if (closed) {
    // `onerror` fired synchronously while the stream was being created, before
    // we could register its close function. Close it now and skip the map so
    // the next sync retries cleanly.
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

/**
 * Query the local database for all registered public keys and open
 * streams for any that aren't already being watched.
 */
const syncWatchedAccounts = async () => {
  if (isSyncing) return; // previous cycle still running — don't stack streams
  isSyncing = true;

  try {
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

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------
const shutdown = async () => {
  logger.info(`\n[${timestamp()}] Shutting down Horizon listener...`);

  // Stop the poll timer so no new sync (and therefore no new stream) starts.
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
  if (fraudStream) await fraudStream.quit();
  await prisma.$disconnect();
  process.exit(0);
};

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

  // Schedule webhook retry / liveness pings
  try {
    scheduleWebhookRetryJob({ prisma });
  } catch (err) {
    logger.error('Failed to schedule webhook retry job:', err.message);
  }

  // Periodically check for newly registered accounts. The handle is retained
  // (and unref'd) so shutdown can clear it instead of leaking the timer.
  syncInterval = setInterval(syncWatchedAccounts, POLL_INTERVAL_MS);
  if (syncInterval && typeof syncInterval.unref === 'function') {
    syncInterval.unref();
  }

  return { syncInterval };
};

// Only bootstrap when executed directly (`node horizonListener.js`); importing
// the module (e.g. from tests) must not start streams or install signal
// handlers.
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
  shutdown,
  main,
  activeStreams,
};

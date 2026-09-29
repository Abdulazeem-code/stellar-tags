// SSE Horizon Listener for Real-Time Payment Detection

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


const NETWORK = process.env.HORIZON_NETWORK || 'testnet';

const HORIZON_URLS = {
  testnet: 'https://horizon-testnet.stellar.org',
  public: 'https://horizon.stellar.org',
};

const HORIZON_URL = HORIZON_URLS[NETWORK] || HORIZON_URLS.testnet;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 60000;


const healthCheckBreaker = createBreaker(
  () => horizon.ledgers().latest().call(),
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
          prisma.payment.create({
            data: {
              transactionHash: payment.transaction_hash,
              fromAddress: payment.from,
              toAddress: payment.to,
              amount: parseFloat(payment.amount),
              assetCode: payment.asset_type === 'native' ? 'XLM' : payment.asset_code,
              status: 'completed'
            }
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


const shutdown = async () => {
  logger.info(`\n[${timestamp()}] Shutting down Horizon listener...`);

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
  shutdown,
  main,
  activeStreams,
};

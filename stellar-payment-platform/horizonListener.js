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

const { Horizon } = require('@stellar/stellar-sdk');
const { prisma } = require('./prismaClient');
const { logger } = require('./src/logger');
const { poolGet, poolRun } = require('./src/db');
const {
  dispatchPaymentWebhooks,
  scheduleWebhookRetryJob,
} = require('./src/webhookWorker');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const NETWORK = process.env.HORIZON_NETWORK || 'testnet';

const HORIZON_URLS = {
  testnet: 'https://horizon-testnet.stellar.org',
  public: 'https://horizon.stellar.org',
};

const HORIZON_URL = HORIZON_URLS[NETWORK] || HORIZON_URLS.testnet;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 60000; // Re-check for new accounts every 60s

// ---------------------------------------------------------------------------
// Horizon Server Instance
// ---------------------------------------------------------------------------
const horizon = new Horizon.Server(HORIZON_URL);

// Attempt to connect to the API server's Socket.IO endpoint so detected
// payments can be forwarded to connected clients in real-time. The listener
// runs as a separate process; it connects as a Socket.IO client and emits
// 'payment' events which the server will route to the appropriate room.
try {
  const ioClient = require('socket.io-client');
  const SOCKET_SERVER = process.env.SOCKET_SERVER_URL || `http://localhost:${process.env.PORT || 5000}`;
  global.__socketClient = ioClient(SOCKET_SERVER, { reconnection: true });
  global.__socketClient.on('connect', () => logger.info('[SocketClient] connected to server'));
  global.__socketClient.on('connect_error', (err) => logger.error('[SocketClient] connect_error', err));
} catch (err) {
  logger.warn('Socket.IO client not available; real-time notifications disabled', err?.message || err);
}

// Track active streams so we can clean up on shutdown
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
 * Open a payment SSE stream for a single Stellar account.
 * Returns the stream close function.
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

            // If a Socket.IO server is available, emit the payment event so
            // connected clients listening for this account receive a real-time
            // notification. The horizon listener connects as a client to the
            // API server and emits a 'payment' event with the address and payload.
            try {
              if (typeof global.__socketClient !== 'undefined' && global.__socketClient && global.__socketClient.connected) {
                global.__socketClient.emit('payment', { address: accountId, payment });
              }
            } catch (err) {
              logger.error('Failed to emit payment over socket client', err);
            }
          }
<<<<<<< HEAD
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
        }
=======
>>>>>>> 4095f79 (feat(websockets): add Socket.IO server and horizon listener forwarding (fix #430))
      },
      onerror: (error) => {
        logger.error(
          `[${timestamp()}] ⚠️  Stream error for ${accountId}:`,
          error?.message || error,
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

  // Schedule webhook retry / liveness pings
  try {
    scheduleWebhookRetryJob({ prisma, poolAllFn: require('./src/db').poolAll, poolRunFn: poolRun });
  } catch (err) {
    logger.error('Failed to schedule webhook retry job:', err.message);
  }

  // Periodically check for newly registered accounts
  setInterval(syncWatchedAccounts, POLL_INTERVAL_MS);
};

main().catch((err) => {
  logger.error('Fatal error starting Horizon listener:', err);
  process.exit(1);
});

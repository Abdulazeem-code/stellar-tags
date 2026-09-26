// ---------------------------------------------------------------------------
// SSE Horizon Listener for Real-Time Payment Detection
// ---------------------------------------------------------------------------
// This background service connects to the Stellar Horizon network using
// Server-Sent Events (SSE) to monitor incoming payments for all public keys
// registered in the local federation database.
//
// Horizon is a shared, rate-limited public service, so every request this
// process makes is scheduled through an exponential-backoff-with-jitter policy
// (see src/horizonBackoff.js) rather than a fixed interval:
//   * failed cycles double the delay, up to POLL_MAX_INTERVAL_MS;
//   * consecutive empty cycles stretch the interval gently;
//   * every delay is jittered so co-located instances don't retry in lockstep;
//   * HTTP 429 responses set a hard floor via their Retry-After header.
//
// Usage:
//   npm run listener                  (testnet, default)
//   HORIZON_NETWORK=public npm run listener  (mainnet)
// ---------------------------------------------------------------------------

'use strict';

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
  HORIZON_BASE,
  HORIZON_NETWORK,
} = require('./src/services/stellarService');
const {
  createBackoffController,
  isRateLimitError,
} = require('./src/horizonBackoff');
const metrics = require('./src/metrics');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const NETWORK = HORIZON_NETWORK || process.env.HORIZON_NETWORK || 'testnet';

// Single source of truth for the endpoint: this is the exact URL the SDK
// client above was constructed with, so the health probe and the SSE streams
// can never disagree about which network they are talking to.
const HORIZON_URL = HORIZON_BASE;

const toPositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Base delay between poll cycles. Also the ceiling-of-record for the healthy
 * steady state: with zero failures the loop never waits longer than this.
 */
const POLL_INTERVAL_MS = toPositiveInt(
  process.env.POLL_INTERVAL_MS,
  toPositiveInt(process.env.HORIZON_POLL_BASE_MS, 60_000),
);

/** Hard ceiling for the exponential curve while Horizon is unhealthy. */
const POLL_MAX_INTERVAL_MS = toPositiveInt(
  process.env.POLL_MAX_INTERVAL_MS,
  900_000,
);

/** Base delay before reconnecting a dropped SSE stream. */
const STREAM_RECONNECT_BASE_MS = toPositiveInt(
  process.env.STREAM_RECONNECT_BASE_MS,
  5_000,
);

/** Ceiling for a repeatedly failing SSE reconnect. */
const STREAM_RECONNECT_MAX_MS = toPositiveInt(
  process.env.STREAM_RECONNECT_MAX_MS,
  300_000,
);

/** Timeout for the lightweight Horizon reachability probe. */
const HEALTH_PROBE_TIMEOUT_MS = toPositiveInt(
  process.env.HORIZON_HEALTH_TIMEOUT_MS,
  5_000,
);

/** Consecutive empty cycles tolerated before the poll interval stretches. */
const POLL_EMPTY_THRESHOLD = toPositiveInt(
  process.env.POLL_EMPTY_THRESHOLD,
  3,
);

/** Jitter strategy: 'equal' (default), 'full' or 'none'. */
const POLL_JITTER = process.env.HORIZON_POLL_JITTER || 'equal';

// ---------------------------------------------------------------------------
// Horizon Reachability Probe + Circuit Breaker
// ---------------------------------------------------------------------------
// The probe uses fetch rather than the SDK call builder on purpose: the SDK's
// `NetworkError` discards the HTTP status, which would make a 429
// indistinguishable from a generic outage and throw away the Retry-After hint
// that is the single most effective way to avoid a rate-limit storm.
const probeHorizon = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const response = await fetch(`${HORIZON_URL}/ledgers?limit=1`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (response.status === 429) {
      const error = new Error('Horizon rate limited (HTTP 429)');
      error.status = 429;
      error.headers = response.headers;
      throw error;
    }

    if (!response.ok) {
      const error = new Error(`Horizon probe failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return true;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Wraps the probe so a sustained outage fast-fails subsequent cycles instead of
 * opening streams (or hitting the DB) that will immediately error.
 */
const healthCheckBreaker = createBreaker(probeHorizon, {
  // Slightly longer than the fetch's own abort so the probe produces a real
  // error (with a usable status) instead of a breaker timeout.
  timeout: HEALTH_PROBE_TIMEOUT_MS + 1_000,
  volumeThreshold: 3,
});

// ---------------------------------------------------------------------------
// Backoff Controllers
// ---------------------------------------------------------------------------
const pollBackoff = createBackoffController({
  baseDelayMs: POLL_INTERVAL_MS,
  maxDelayMs: POLL_MAX_INTERVAL_MS,
  emptyStreakThreshold: POLL_EMPTY_THRESHOLD,
  jitter: POLL_JITTER,
});

/** Per-account SSE reconnect policies, created lazily. */
const streamBackoffs = new Map();

const getStreamBackoff = (accountId) => {
  if (!streamBackoffs.has(accountId)) {
    streamBackoffs.set(
      accountId,
      createBackoffController({
        baseDelayMs: STREAM_RECONNECT_BASE_MS,
        maxDelayMs: STREAM_RECONNECT_MAX_MS,
        jitter: POLL_JITTER,
      }),
    );
  }
  return streamBackoffs.get(accountId);
};

// ---------------------------------------------------------------------------
// Stream Management
// ---------------------------------------------------------------------------
/** accountId -> stream handle ({ close, disposed }). */
const activeStreams = new Map();
/** accountId -> pending reconnect timer. */
const reconnectTimers = new Map();

const timestamp = () => new Date().toISOString();

const recordRateLimit = (error) => {
  if (isRateLimitError(error)) metrics.horizonRateLimited.inc();
};

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

/** Cancel a pending reconnect for an account, if one is scheduled. */
const cancelReconnect = (accountId) => {
  const timer = reconnectTimers.get(accountId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(accountId);
  }
};

/**
 * Close a stream and drop it from the active set.
 *
 * The account's backoff state is intentionally preserved: an error-triggered
 * close must be able to keep escalating the reconnect delay, and only a
 * genuinely forgotten account (removed, or shutting down) discards it via
 * `forgetAccount()`.
 */
const closeStream = (accountId, reason) => {
  const handle = activeStreams.get(accountId);
  if (!handle) return;

  // Mark disposed first: the SDK may emit a late error from this connection as
  // it shuts down, and that must not disturb a replacement stream.
  handle.disposed = true;
  if (typeof handle.close === 'function') {
    handle.close();
    metrics.horizonStreams.inc({ event: 'closed' });
  }

  activeStreams.delete(accountId);
  if (reason) {
    logger.info(`[${timestamp()}] 🛑 Closed stream for ${accountId} (${reason})`);
  }
};

/** Close a stream and discard all reconnect state for the account. */
const forgetAccount = (accountId, reason) => {
  closeStream(accountId, reason);
  cancelReconnect(accountId);
  streamBackoffs.delete(accountId);
};

/**
 * Schedule a jittered, backed-off reconnect for a dropped stream. Reconnect
 * timers are tracked per account so a single flapping account cannot be
 * starved by — or starve — the rest.
 */
const scheduleReconnect = (accountId) => {
  cancelReconnect(accountId);

  const backoff = getStreamBackoff(accountId);
  const { delayMs, attempt } = backoff.nextDelay();

  logger.info(
    `[${timestamp()}] 🔄 Reconnecting ${accountId} in ${Math.round(delayMs / 1000)}s ` +
      `(attempt ${attempt})`,
  );
  metrics.horizonPollBackoffSeconds.set({ scope: 'stream' }, delayMs / 1000);

  const timer = setTimeout(() => {
    reconnectTimers.delete(accountId);
    watchAccount(accountId);
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  reconnectTimers.set(accountId, timer);
};

/**
 * Open a payment SSE stream for a single Stellar account.
 *
 * On error the stream is closed and a jittered reconnect is scheduled. Closing
 * matters: the SDK's EventSource reconnects on its own, so leaving it open
 * would let the next poll cycle open a *second* stream for the same account —
 * duplicate webhooks and double the Horizon load.
 *
 * @returns {boolean} True when a new stream was opened.
 */
const watchAccount = (accountId) => {
  if (activeStreams.has(accountId)) {
    return false; // Already watching
  }

  // The poll loop beat a pending reconnect to this account; drop the timer.
  cancelReconnect(accountId);

  const backoff = getStreamBackoff(accountId);
  // Tracks the live stream so a late error from a superseded connection can't
  // tear down a healthy replacement.
  const handle = { close: null, disposed: false };

  const onStreamError = (error) => {
    // Ignore errors from a stream that has already been closed or replaced.
    if (handle.disposed) return;

    const rateLimited = isRateLimitError(error);
    logger.error(
      `[${timestamp()}] ⚠️  Stream error for ${accountId}:`,
      error?.message || error,
    );

    closeStream(accountId);
    metrics.horizonStreams.inc({ event: 'error' });
    recordRateLimit(error);

    // A rate-limited stream must wait out Horizon's own cool-down, which
    // onFailure() records as a floor on the next reconnect.
    backoff.onFailure(error);

    if (rateLimited) {
      logger.warn(
        `[${timestamp()}] 🐢 Horizon rate limited; retrying ${accountId} after ` +
          `${Math.round(backoff.retryAfterMs / 1000)}s`,
      );
    }

    scheduleReconnect(accountId);
  };

  logger.info(`[${timestamp()}] 👁️  Watching payments for ${accountId}`);

  handle.close = horizon
    .payments()
    .forAccount(accountId)
    .cursor('now')
    .stream({
      onmessage: (payment) => {
        // A delivered message is the strongest proof the stream is healthy.
        backoff.onSuccess();

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
        }
      },
      onerror: onStreamError,
    });

  // `.stream()` can invoke onerror synchronously (e.g. EventSource fails to
  // construct). In that case the reconnect is already scheduled and registering
  // the dead handle would block it.
  if (handle.disposed) return true;

  activeStreams.set(accountId, handle);
  metrics.horizonStreams.inc({ event: 'opened' });
  return true;
};

/**
 * Query the local database for all registered public keys and reconcile the
 * set of open streams with it.
 *
 * @returns {Promise<{accounts: number, streams: number, opened: number, closed: number}>}
 *   A summary of the cycle, used to decide whether it was productive.
 */
const syncWatchedAccounts = async () => {
  const rows = await prisma.user.findMany({
    distinct: ['address'],
    select: { address: true },
  });

  const currentAddresses = new Set(rows.map((r) => r.address));
  let opened = 0;
  let closed = 0;

  // Start watching new accounts
  for (const { address } of rows) {
    if (watchAccount(address)) opened += 1;
  }

  // Stop watching removed accounts
  for (const address of [...activeStreams.keys()]) {
    if (!currentAddresses.has(address)) {
      forgetAccount(address, 'account removed');
      closed += 1;
    }
  }

  logger.info(
    `[${timestamp()}] 📡 Actively monitoring ${activeStreams.size} account(s) ` +
      `(+${opened} opened, -${closed} closed)`,
  );

  return {
    accounts: currentAddresses.size,
    streams: activeStreams.size,
    opened,
    closed,
  };
};

// ---------------------------------------------------------------------------
// Poll Loop
// ---------------------------------------------------------------------------
// A recursive setTimeout replaces the old fixed setInterval for two reasons:
// the delay has to be able to change per cycle, and a slow cycle must not be
// able to overlap the next one.
let pollTimer = null;
let pollStopped = false;
let pollInFlight = false;

/**
 * Arm the timer for the next cycle.
 *
 * The delay is drawn exactly once per cycle and threaded through from
 * `runPollCycle`, so the value logged here always matches the value actually
 * scheduled. Drawing twice would jitter the reported number away from the real
 * one and make the logs impossible to reason about.
 *
 * @param {{delayMs: number, attempt: number}} [delay] Pre-drawn backoff info.
 */
const scheduleNextPoll = (delay) => {
  if (pollStopped) return;

  // Exactly one timer may be pending. Without this, a cycle triggered outside
  // the timer (a manual kick, a health endpoint) would stack a second timer and
  // double the polling rate.
  if (pollTimer) clearTimeout(pollTimer);

  const { delayMs, attempt } = delay || pollBackoff.nextDelay();
  pollTimer = setTimeout(runPollCycle, delayMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  metrics.horizonPollBackoffSeconds.set({ scope: 'poll' }, delayMs / 1000);
  metrics.horizonPollFailures.set(attempt);

  logger.info(
    `[${timestamp()}] ⏱️  Next Horizon poll in ${Math.round(delayMs / 1000)}s ` +
      `(attempt ${attempt})`,
  );
};

const runPollCycle = async () => {
  if (pollStopped) return;
  // Defensive: the timer is only re-armed after the previous cycle settles, so
  // this should be unreachable, but a hung dependency must not stack cycles.
  if (pollInFlight) return;

  pollInFlight = true;
  const startedAt = Date.now();
  let next;

  try {
    // Fast-fail when Horizon is known to be down — don't waste resources
    // opening streams that will immediately error.
    await healthCheckBreaker.fire();

    const summary = await syncWatchedAccounts();
    metrics.horizonPollDuration.observe((Date.now() - startedAt) / 1000);

    // An empty cycle means there is genuinely nothing to watch yet. Stretching
    // the interval there is free: nobody is waiting on a new account stream.
    if (summary.accounts === 0 && summary.streams === 0) {
      pollBackoff.onEmpty();
      metrics.horizonPollCycles.inc({ outcome: 'empty' });
      next = pollBackoff.nextDelay();
      logger.info(
        `[${timestamp()}] 😴 No accounts registered yet; next poll in ` +
          `${Math.round(next.delayMs / 1000)}s (attempt ${next.attempt})`,
      );
    } else {
      pollBackoff.onSuccess();
      metrics.horizonPollCycles.inc({ outcome: 'success' });
      metrics.horizonLastSuccessTimestamp.set(Date.now() / 1000);
    }
  } catch (err) {
    metrics.horizonPollDuration.observe((Date.now() - startedAt) / 1000);
    pollBackoff.onFailure(err);
    recordRateLimit(err);

    const outcome = isRateLimitError(err) ? 'rate_limited' : 'failure';
    metrics.horizonPollCycles.inc({ outcome });

    next = pollBackoff.nextDelay();
    logger.error(
      `[${timestamp()}] ❌ Horizon poll cycle failed (${outcome}):`,
      err?.message || err,
    );
    logger.warn(
      `[${timestamp()}] ⏸️  Backing off to ${Math.round(next.delayMs / 1000)}s ` +
        `before the next poll (attempt ${next.attempt})`,
    );
  } finally {
    pollInFlight = false;
    scheduleNextPoll(next);
  }
};

/** Stop the poll loop. Safe to call more than once. */
const stopPolling = () => {
  pollStopped = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
};

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------
const shutdown = async () => {
  logger.info(`\n[${timestamp()}] Shutting down Horizon listener...`);
  stopPolling();
  for (const address of [...activeStreams.keys()]) {
    forgetAccount(address);
  }
  activeStreams.clear();
  await closeWebhookQueue();
  await prisma.$disconnect();
  process.exit(0);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const main = async () => {
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('═══════════════════════════════════════════════════════');
  logger.info('  Stellar Horizon Payment Listener');
  logger.info(`  Network:  ${NETWORK.toUpperCase()}`);
  logger.info(`  Horizon:  ${HORIZON_URL}`);
  logger.info(
    `  Poll:     ${POLL_INTERVAL_MS / 1000}s base, up to ` +
      `${POLL_MAX_INTERVAL_MS / 1000}s with exponential backoff ` +
      `(${POLL_JITTER} jitter)`,
  );
  logger.info('═══════════════════════════════════════════════════════');

  // Start the durable Redis-backed webhook delivery worker.
  startWebhookWorker({ prisma, poolRunFn: poolRun });

  // First cycle runs immediately, then reschedules itself on a backoff timer.
  await runPollCycle();
};

module.exports = {
  // Entry points
  main,
  probeHorizon,
  // Polling / scheduling
  runPollCycle,
  scheduleNextPoll,
  stopPolling,
  // Streams
  watchAccount,
  closeStream,
  forgetAccount,
  scheduleReconnect,
  syncWatchedAccounts,
  // State (exposed for tests and introspection)
  activeStreams,
  reconnectTimers,
  streamBackoffs,
  pollBackoff,
  healthCheckBreaker,
  // Config
  POLL_INTERVAL_MS,
  POLL_MAX_INTERVAL_MS,
  STREAM_RECONNECT_BASE_MS,
  STREAM_RECONNECT_MAX_MS,
  HORIZON_URL,
};

// Only boot when executed directly, so tests can import the module without
// starting timers or opening Horizon connections.
if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal error starting Horizon listener:', err);
    process.exit(1);
  });
}

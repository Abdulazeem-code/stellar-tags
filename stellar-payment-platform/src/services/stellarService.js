'use strict';

/**
 * Stellar Horizon Service with Circuit Breaker Protection
 *
 * Centralizes all Horizon SDK interactions behind an opossum circuit breaker.
 * When Horizon fails repeatedly, the breaker "opens" and fast-fails subsequent
 * requests instead of letting them pile up and crash the process.
 *
 * Callers can check `err.name === 'CircuitBreakerOpenError'` to distinguish
 * a tripped breaker from a normal Horizon error (e.g. 404).
 */

const { Horizon } = require('@stellar/stellar-sdk');
const CircuitBreaker = require('opossum');
const { logger } = require('../logger');

// ---------------------------------------------------------------------------
// Configuration (env-overridable)
// ---------------------------------------------------------------------------
const HORIZON_BASE = process.env.HORIZON_BASE || 'https://horizon-testnet.stellar.org';

const BREAKER_THRESHOLD = parseInt(process.env.CB_THRESHOLD, 10) || 5;
const BREAKER_TIMEOUT = parseInt(process.env.CB_TIMEOUT_MS, 10) || 10000;
const BREAKER_RESET_TIMEOUT = parseInt(process.env.CB_RESET_TIMEOUT_MS, 10) || 30000;

// ---------------------------------------------------------------------------
// Horizon Server Instance
// ---------------------------------------------------------------------------
const horizon = new Horizon.Server(HORIZON_BASE);

// ---------------------------------------------------------------------------
// Circuit Breaker Defaults
// ---------------------------------------------------------------------------
const defaultOptions = {
  timeout: BREAKER_TIMEOUT,
  errorThresholdPercentage: 50,
  resetTimeout: BREAKER_RESET_TIMEOUT,
  volumeThreshold: BREAKER_THRESHOLD,
};

/**
 * Creates a circuit breaker around an async function.
 * Logs state transitions so operators can see open/close events in log output.
 * When the circuit opens, opossum throws a `CircuitBreakerOpenError` which
 * callers can detect to provide a user-friendly message.
 */
function createBreaker(fn, options = {}) {
  const breaker = new CircuitBreaker(fn, { ...defaultOptions, ...options });

  breaker.on('open', () =>
    logger.warn('[CircuitBreaker] Circuit OPENED — fast-failing requests'),
  );
  breaker.on('halfOpen', () =>
    logger.info('[CircuitBreaker] Circuit HALF-OPEN — testing recovery'),
  );
  breaker.on('close', () =>
    logger.info('[CircuitBreaker] Circuit CLOSED — service recovered'),
  );
  breaker.on('fallback', () =>
    logger.warn('[CircuitBreaker] Fallback invoked'),
  );
  breaker.on('failure', (err) =>
    logger.debug('[CircuitBreaker] Request failed:', err?.message || err),
  );

  return breaker;
}

// ---------------------------------------------------------------------------
// Circuit-Breaker–Wrapped Horizon Helpers
// ---------------------------------------------------------------------------

/**
 * Load an account from Horizon (used by multisigner-verifier).
 * When the breaker is open, opossum throws CircuitBreakerOpenError.
 */
const loadAccountBreaker = createBreaker(
  (accountId) => horizon.loadAccount(accountId),
);

async function loadAccount(accountId) {
  return loadAccountBreaker.fire(accountId);
}

/**
 * Fetch a single transaction by hash.
 */
const fetchTransactionBreaker = createBreaker(
  (txHash) => horizon.transactions().transaction(txHash).call(),
);

async function fetchTransaction(txHash) {
  return fetchTransactionBreaker.fire(txHash);
}

/**
 * Fetch all payment operations for a given transaction.
 */
const fetchPaymentsForTransactionBreaker = createBreaker(
  (txHash) => horizon.payments().forTransaction(txHash).call(),
);

async function fetchPaymentsForTransaction(txHash) {
  return fetchPaymentsForTransactionBreaker.fire(txHash);
}

/**
 * Fetch a page of payment records for an account.
 * When the circuit is open the promise rejects immediately with a
 * `CircuitBreakerOpenError` instead of hanging on the HTTP timeout.
 */
const fetchPaymentsForAccountBreaker = createBreaker(
  ({ address, limit, cursor, order }) => {
    let call = horizon.payments().forAccount(address).order(order).limit(limit);
    if (cursor) call = call.cursor(cursor);
    return call.call();
  },
);

async function fetchPaymentsForAccount({ address, limit, cursor, order }) {
  return fetchPaymentsForAccountBreaker.fire({ address, limit, cursor, order });
}

/**
 * Fetch the first page of payments for an account (used by export).
 * Returns a page-like object whose `.next()` method is also circuit-protected.
 */
const fetchFirstPaymentsPageBreaker = createBreaker(
  ({ address, order, pageSize }) =>
    horizon.payments().forAccount(address).order(order).limit(pageSize).call(),
);

async function fetchFirstPaymentsPage({ address, order, pageSize }) {
  const page = await fetchFirstPaymentsPageBreaker.fire({ address, order, pageSize });
  return wrapPageWithBreaker(page);
}

/**
 * Wraps a Horizon pagination result so its `.next()` call is also circuit-
 * protected.  Non-Horizon calls (e.g. `records`, `_embedded`) pass through.
 */
function wrapPageWithBreaker(page) {
  if (!page || typeof page.next !== 'function') return page;

  const originalNext = page.next.bind(page);
  const nextBreaker = createBreaker((cursor) => {
    if (cursor) return originalNext(cursor);
    return originalNext();
  });

  return Object.create(page, {
    next: {
      value: (...args) => nextBreaker.fire(...args),
      writable: true,
      configurable: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Horizon server instance (use directly for SSE streaming, etc.)
  horizon,

  // Configuration (useful for tests / introspection)
  HORIZON_BASE,
  BREAKER_THRESHOLD,
  BREAKER_TIMEOUT,
  BREAKER_RESET_TIMEOUT,

  // Circuit-breaker–wrapped helpers
  loadAccount,
  fetchTransaction,
  fetchPaymentsForTransaction,
  fetchPaymentsForAccount,
  fetchFirstPaymentsPage,

  // Low-level: create a breaker around any async function
  createBreaker,

  // Low-level: wrap a Horizon page so `.next()` is protected
  wrapPageWithBreaker,
};

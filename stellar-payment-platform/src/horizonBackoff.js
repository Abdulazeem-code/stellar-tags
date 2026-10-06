'use strict';

/**
 * Exponential Backoff With Jitter for Horizon API Traffic
 *
 * Horizon is a shared, rate-limited public service. Polling it on a fixed
 * interval is wasteful when nothing has changed and actively harmful when
 * Horizon is struggling: every client retrying on the same schedule produces a
 * "thundering herd" that keeps the service overloaded (a self-sustaining
 * outage). This module centralises the delay policy so the listener's poll loop
 * and its SSE stream reconnects share one well-tested implementation.
 *
 * Design notes:
 *  - Delay grows exponentially with the number of consecutive failures and is
 *    clamped to `maxDelayMs` so a long outage cannot push the next attempt
 *    hours into the future.
 *  - Every delay is jittered. "Equal jitter" (the default) keeps the result in
 *    [50%, 100%] of the nominal delay: wide enough to de-synchronise clients
 *    that all started at the same instant, tight enough that the documented
 *    backoff curve stays meaningful. "Full" jitter samples [0%, 100%] for
 *    aggressive de-correlation.
 *  - HTTP 429 responses carry a `Retry-After` header. It is treated as a hard
 *    floor on the next delay, so we never retry before Horizon asks us to.
 */

const { logger } = require('./logger');

// ---------------------------------------------------------------------------
// Configuration (env-overridable)
// ---------------------------------------------------------------------------

const toPositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Defaults are tuned for Horizon testnet's published budget: a 60s baseline
 * poll that can stretch to 15 minutes during a sustained outage.
 */
const BACKOFF_DEFAULTS = Object.freeze({
  baseDelayMs: toPositiveInt(process.env.HORIZON_POLL_BASE_MS, 60_000),
  maxDelayMs: toPositiveInt(process.env.HORIZON_POLL_MAX_MS, 900_000),
  factor: 2,
  jitter: 'equal',
  /**
   * Consecutive "nothing to do" cycles tolerated before the poll loop starts
   * stretching its interval. An empty result usually means the federation table
   * is empty and there is no reason to re-query at full speed.
   */
  emptyStreakThreshold: toPositiveInt(
    process.env.HORIZON_POLL_EMPTY_THRESHOLD,
    3,
  ),
  /**
   * A `Retry-After` longer than this is treated as untrustworthy and ignored;
   * a hostile or buggy header must not be able to park the listener for a day.
   */
  maxRetryAfterMs: toPositiveInt(process.env.HORIZON_POLL_MAX_RETRY_AFTER_MS, 3_600_000),
});

/** Coerce a config object over the defaults, discarding invalid values. */
function resolveConfig(overrides = {}) {
  const config = { ...BACKOFF_DEFAULTS, ...overrides };
  return {
    ...config,
    baseDelayMs: toPositiveInt(config.baseDelayMs, BACKOFF_DEFAULTS.baseDelayMs),
    maxDelayMs: toPositiveInt(config.maxDelayMs, BACKOFF_DEFAULTS.maxDelayMs),
    emptyStreakThreshold: toPositiveInt(
      config.emptyStreakThreshold,
      BACKOFF_DEFAULTS.emptyStreakThreshold,
    ),
    maxRetryAfterMs: toPositiveInt(
      config.maxRetryAfterMs,
      BACKOFF_DEFAULTS.maxRetryAfterMs,
    ),
  };
}

// ---------------------------------------------------------------------------
// Jitter
// ---------------------------------------------------------------------------

/**
 * Spread `nominal` across a window according to the configured strategy.
 *
 * @param {number} nominal  Un-jittered delay in milliseconds.
 * @param {'equal'|'full'|'none'} strategy
 * @param {() => number} random  Injectable RNG so tests stay deterministic.
 * @returns {number} Jittered delay in milliseconds, never below 1ms.
 */
function applyJitter(nominal, strategy, random) {
  const safeNominal = Math.max(0, nominal);

  if (strategy === 'none') return Math.round(safeNominal);
  if (strategy === 'full') return Math.round(random() * safeNominal);

  // Default: equal jitter — [50%, 100%] of the nominal delay.
  return Math.round(safeNominal * (0.5 + random() * 0.5));
}

/**
 * Exponential growth with a ceiling, before jitter.
 * `base * factor^attempt`, clamped to `maxDelayMs`.
 *
 * @param {number} attempt  Zero-based count of consecutive failures.
 */
function nominalDelay(attempt, config) {
  const exponent = Math.max(0, attempt);
  // Cap the exponent before the multiply: `2 ** 1024` is Infinity, and Infinity
  // would poison the Math.min() below into a NaN-free but meaningless result.
  const safeExponent = Math.min(exponent, 31);
  const raw = config.baseDelayMs * config.factor ** safeExponent;
  return Math.min(raw, config.maxDelayMs);
}

// ---------------------------------------------------------------------------
// Error Introspection
// ---------------------------------------------------------------------------

/** True when an error represents an HTTP 429 from Horizon. */
function isRateLimitError(error) {
  if (!error) return false;

  const status =
    error.status ?? error.statusCode ?? error.response?.status ?? null;
  if (status === 429) return true;

  // The Stellar SDK's `NetworkError` drops the HTTP status and keeps only the
  // status text plus the parsed body, so a 429 can arrive as an ordinary Error
  // with no status at all. Fall back to matching the status text before
  // treating a rate limit as a generic failure.
  const message = String(error.message || error.statusText || '');
  return /\b429\b|too many requests|rate limit/i.test(message);
}

/**
 * Pull the `Retry-After` value out of an error, tolerating the shapes used by
 * the Stellar SDK (axios) and by hand-rolled fetch wrappers.
 */
function extractRetryAfterHeader(error) {
  const headers =
    error?.response?.headers || error?.headers || error?.rawHeaders || null;
  if (!headers) return null;

  if (typeof headers.get === 'function') return headers.get('retry-after');

  const key = Object.keys(headers).find(
    (k) => k.toLowerCase() === 'retry-after',
  );
  return key ? headers[key] : null;
}

/**
 * Parse a `Retry-After` header into milliseconds.
 *
 * Accepts both permitted forms: delta-seconds ("120") and an HTTP-date
 * ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns null when the value is absent or
 * unparseable so callers can fall back to plain backoff.
 *
 * @param {string|number|null} value
 * @param {number} [now]  Injectable clock for deterministic tests.
 */
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;

  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return asNumber >= 0 ? Math.round(asNumber * 1000) : null;
  }

  const asDate = Date.parse(String(value));
  if (Number.isNaN(asDate)) return null;

  // A date already in the past means "retry now", never a negative delay.
  return Math.max(0, asDate - now);
}

/**
 * Resolve the minimum delay Horizon is asking for via `Retry-After`, or null
 * when the error carries no usable instruction.
 *
 * @returns {number|null} Milliseconds to wait, or null.
 */
function extractRetryAfterMs(error, { now = Date.now(), maxMs = BACKOFF_DEFAULTS.maxRetryAfterMs } = {}) {
  const parsed = parseRetryAfter(extractRetryAfterHeader(error), now);
  if (parsed === null) return null;
  return Math.min(parsed, maxMs);
}

// ---------------------------------------------------------------------------
// Backoff Controller
// ---------------------------------------------------------------------------

/**
 * Stateful delay policy for one repeating Horizon task (the poll loop, or a
 * single SSE stream reconnect). Call `nextDelay()` to schedule, then report the
 * outcome back with `onSuccess()`, `onFailure()` or `onEmpty()`.
 *
 * @example
 *   const controller = createBackoffController({ baseDelayMs: 60_000 });
 *   setTimeout(poll, controller.nextDelay());
 *   // ...inside poll:
 *   controller.onFailure(err); // 429 -> next delay respects Retry-After
 */
function createBackoffController(overrides = {}) {
  const config = resolveConfig(overrides);
  const random =
    typeof overrides.random === 'function' ? overrides.random : Math.random;

  let failureAttempt = 0;
  let emptyStreak = 0;
  let retryAfterMs = 0;

  // `maxDelayMs` caps our own backoff curve. It must NOT cap the Retry-After
  // floor, otherwise a 30-minute cool-off from Horizon would be shortened to
  // maxDelayMs and we'd retry into a known rate limit — the exact thing this
  // module exists to prevent. maxRetryAfterMs is the sanity bound instead.
  const MAX_ALLOWED = Math.max(config.maxDelayMs, config.maxRetryAfterMs);
  const clamp = (ms) => Math.max(1, Math.min(Math.round(ms), MAX_ALLOWED));

  return {
    config,

    /** Consecutive hard failures (resets on any success). */
    get failureAttempt() {
      return failureAttempt;
    },

    /** Consecutive non-fatal "nothing happened" cycles. */
    get emptyStreak() {
      return emptyStreak;
    },

    /** Floor imposed by the most recent `Retry-After`, in milliseconds. */
    get retryAfterMs() {
      return retryAfterMs;
    },

    /** A successful, productive cycle clears all backoff state. */
    onSuccess() {
      failureAttempt = 0;
      emptyStreak = 0;
      retryAfterMs = 0;
    },

    /**
     * A failed cycle advances the exponential curve. `Retry-After` (if the
     * error is a 429) becomes a floor on the next delay so we never retry
     * before Horizon's own cool-down expires.
     *
     * @param {Error & {status?: number}} [error]
     * @param {number} [now]  Injectable clock.
     */
    onFailure(error, now = Date.now()) {
      failureAttempt += 1;
      emptyStreak = 0;

      if (isRateLimitError(error)) {
        retryAfterMs = extractRetryAfterMs(error, {
          now,
          maxMs: config.maxRetryAfterMs,
        }) || 0;
        logger.warn(
          `[horizon-backoff] Rate limited (attempt ${failureAttempt}); ` +
            `honouring Retry-After of ${retryAfterMs}ms`,
        );
      } else {
        retryAfterMs = 0;
      }
    },

    /**
     * A cycle that succeeded but found nothing to do. The interval stretches
     * gently rather than exponentially — the service is healthy, there is just
     * nothing new — and only after `emptyStreakThreshold` consecutive empties.
     */
    onEmpty() {
      emptyStreak += 1;
      if (emptyStreak >= config.emptyStreakThreshold) {
        failureAttempt += 1;
      }
    },

    /**
     * Compute the delay before the next attempt. Always jittered.
     *
     * @returns {{ delayMs: number, nominalMs: number, attempt: number, jitterMs: number, retryAfterMs: number }}
     */
    nextDelay() {
      const nominalMs = nominalDelay(failureAttempt, config);
      const jittered = applyJitter(nominalMs, config.jitter, random);
      // Retry-After wins whenever it exceeds our own schedule.
      const delayMs = clamp(Math.max(jittered, retryAfterMs));

      return {
        delayMs,
        nominalMs,
        attempt: failureAttempt,
        jitterMs: delayMs - Math.round(nominalMs),
        retryAfterMs,
      };
    },

    /** Convenience: schedule-and-apply for callers that only need the number. */
    currentDelayMs() {
      return this.nextDelay().delayMs;
    },

    /** Drop all accumulated backoff (used on graceful restart of a task). */
    reset() {
      failureAttempt = 0;
      emptyStreak = 0;
      retryAfterMs = 0;
    },
  };
}

module.exports = {
  BACKOFF_DEFAULTS,
  applyJitter,
  nominalDelay,
  isRateLimitError,
  extractRetryAfterHeader,
  extractRetryAfterMs,
  parseRetryAfter,
  createBackoffController,
};

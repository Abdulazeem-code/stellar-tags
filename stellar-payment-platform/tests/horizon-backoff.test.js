// ---------------------------------------------------------------------------
// Tests for the Horizon exponential-backoff-with-jitter policy
// ---------------------------------------------------------------------------

jest.mock('../src/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
  httpLogger: (req, res, next) => next(),
}));

const {
  BACKOFF_DEFAULTS,
  applyJitter,
  nominalDelay,
  isRateLimitError,
  extractRetryAfterHeader,
  extractRetryAfterMs,
  parseRetryAfter,
  createBackoffController,
} = require('../src/horizonBackoff');

/** A deterministic RNG cycling through fixed values. */
const sequence = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('horizonBackoff', () => {
  describe('applyJitter', () => {
    it('keeps equal jitter inside [50%, 100%] of the nominal delay', () => {
      expect(applyJitter(1_000, 'equal', () => 0)).toBe(500);
      expect(applyJitter(1_000, 'equal', () => 0.5)).toBe(750);
      expect(applyJitter(1_000, 'equal', () => 1)).toBe(1_000);
    });

    it('spreads full jitter across [0%, 100%] of the nominal delay', () => {
      expect(applyJitter(1_000, 'full', () => 0)).toBe(0);
      expect(applyJitter(1_000, 'full', () => 1)).toBe(1_000);
    });

    it('returns the nominal delay when jitter is disabled', () => {
      expect(applyJitter(1_234, 'none', () => 0.99)).toBe(1_234);
    });

    it('never produces a negative delay', () => {
      expect(applyJitter(-500, 'equal', () => 0)).toBe(0);
    });

    it('actually varies the delay across draws (anti-synchronisation)', () => {
      const draws = new Set(
        Array.from({ length: 50 }, () => applyJitter(60_000, 'equal', Math.random)),
      );
      // 50 draws from a continuous range collapsing to one value would mean
      // every caller retries in lockstep.
      expect(draws.size).toBeGreaterThan(40);
    });
  });

  describe('nominalDelay', () => {
    const config = { baseDelayMs: 1_000, factor: 2, maxDelayMs: 30_000 };

    it('grows exponentially from the base delay', () => {
      expect(nominalDelay(0, config)).toBe(1_000);
      expect(nominalDelay(1, config)).toBe(2_000);
      expect(nominalDelay(2, config)).toBe(4_000);
      expect(nominalDelay(3, config)).toBe(8_000);
    });

    it('clamps at maxDelayMs', () => {
      expect(nominalDelay(5, config)).toBe(30_000);
      expect(nominalDelay(50, config)).toBe(30_000);
    });

    it('does not overflow to Infinity for absurd attempt counts', () => {
      expect(nominalDelay(5_000, config)).toBe(30_000);
      expect(Number.isFinite(nominalDelay(5_000, config))).toBe(true);
    });

    it('treats a negative attempt as the first attempt', () => {
      expect(nominalDelay(-3, config)).toBe(1_000);
    });
  });

  describe('isRateLimitError', () => {
    it('detects a bare 429 status', () => {
      expect(isRateLimitError({ status: 429 })).toBe(true);
      expect(isRateLimitError({ statusCode: 429 })).toBe(true);
    });

    it('detects a 429 nested under response', () => {
      expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
    });

    // The SDK's NetworkError keeps the status *text* and the response body but
    // throws the numeric status away, so text matching is the only signal left.
    it('detects the SDK NetworkError shape that lost its status code', () => {
      expect(isRateLimitError(new Error('Too Many Requests'))).toBe(true);
      expect(isRateLimitError(new Error('Request failed with status 429'))).toBe(true);
      expect(isRateLimitError({ message: 'rate limit exceeded' })).toBe(true);
    });

    it('does not misclassify other failures', () => {
      expect(isRateLimitError({ status: 500 })).toBe(false);
      expect(isRateLimitError(new Error('socket hang up'))).toBe(false);
      expect(isRateLimitError(null)).toBe(false);
      expect(isRateLimitError(undefined)).toBe(false);
    });
  });

  describe('parseRetryAfter', () => {
    it('parses delta-seconds', () => {
      expect(parseRetryAfter('120')).toBe(120_000);
      expect(parseRetryAfter(30)).toBe(30_000);
      expect(parseRetryAfter('0')).toBe(0);
    });

    it('parses an HTTP-date relative to the supplied clock', () => {
      const now = Date.parse('2026-01-01T00:00:00Z');
      expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now)).toBe(60_000);
    });

    it('clamps a past HTTP-date to zero rather than going negative', () => {
      const now = Date.parse('2026-01-01T00:00:00Z');
      expect(parseRetryAfter('Thu, 01 Jan 2020 00:00:00 GMT', now)).toBe(0);
    });

    it('returns null for missing or unparseable values', () => {
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter(undefined)).toBeNull();
      expect(parseRetryAfter('')).toBeNull();
      expect(parseRetryAfter('soon-ish')).toBeNull();
      expect(parseRetryAfter(-5)).toBeNull();
    });
  });

  describe('extractRetryAfterHeader / extractRetryAfterMs', () => {
    it('reads a plain object header case-insensitively', () => {
      const err = { headers: { 'Retry-After': '45' } };
      expect(extractRetryAfterHeader(err)).toBe('45');
      expect(extractRetryAfterMs(err)).toBe(45_000);
    });

    it('reads a Headers-like object via .get()', () => {
      const err = { response: { headers: new Map([['retry-after', '90']]) } };
      expect(extractRetryAfterHeader(err)).toBe('90');
      expect(extractRetryAfterMs(err)).toBe(90_000);
    });

    it('reads a fetch Headers instance', () => {
      const headers = new Headers({ 'retry-after': '120' });
      expect(extractRetryAfterHeader({ headers })).toBe('120');
      expect(extractRetryAfterMs({ headers })).toBe(120_000);
    });

    it('returns null when there is no header at all', () => {
      expect(extractRetryAfterHeader({ status: 429 })).toBeNull();
      expect(extractRetryAfterMs({ status: 429 })).toBeNull();
    });

    it('bounds an untrustworthy Retry-After to maxMs', () => {
      const err = { headers: { 'retry-after': '86400' } }; // 24 hours
      expect(extractRetryAfterMs(err, { maxMs: 3_600_000 })).toBe(3_600_000);
    });
  });

  describe('createBackoffController', () => {
    const build = (overrides = {}) =>
      createBackoffController({
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        emptyStreakThreshold: 3,
        jitter: 'none',
        ...overrides,
      });

    it('starts at the base delay with no jitter', () => {
      expect(build().nextDelay().delayMs).toBe(1_000);
    });

    it('doubles the delay on each consecutive failure', () => {
      const c = build();
      const seen = [];
      for (let i = 0; i < 5; i += 1) {
        seen.push(c.nextDelay().nominalMs);
        c.onFailure(new Error('boom'));
      }
      expect(seen).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    });

    it('never exceeds maxDelayMs', () => {
      const c = build();
      for (let i = 0; i < 20; i += 1) {
        c.onFailure(new Error('boom'));
        expect(c.nextDelay().delayMs).toBeLessThanOrEqual(60_000);
      }
    });

    it('resets the curve on a success', () => {
      const c = build();
      c.onFailure();
      c.onFailure();
      c.onFailure();
      expect(c.nextDelay().nominalMs).toBe(8_000);
      c.onSuccess();
      expect(c.nextDelay().nominalMs).toBe(1_000);
      expect(c.failureAttempt).toBe(0);
    });

    it('applies jitter to the computed delay', () => {
      const c = build({ jitter: 'equal', random: () => 0.5 });
      c.onFailure();
      // nominal 2000, equal jitter at the midpoint -> 1500
      expect(c.nextDelay().delayMs).toBe(1_500);
    });

    // --- Empty responses ---------------------------------------------------

    it('stretches the interval only after the empty threshold', () => {
      const c = build();
      for (let i = 0; i < 2; i += 1) {
        c.onEmpty();
        expect(c.nextDelay().nominalMs).toBe(1_000);
      }
      c.onEmpty(); // third consecutive empty crosses the threshold
      expect(c.nextDelay().nominalMs).toBe(2_000);
      c.onEmpty();
      expect(c.nextDelay().nominalMs).toBe(4_000);
      expect(c.emptyStreak).toBe(4);
    });

    it('resets the empty streak after a success', () => {
      const c = build();
      c.onEmpty();
      c.onEmpty();
      c.onSuccess();
      expect(c.emptyStreak).toBe(0);
      c.onEmpty();
      expect(c.nextDelay().nominalMs).toBe(1_000);
    });

    it('resets the empty streak after a hard failure', () => {
      const c = build();
      c.onEmpty();
      c.onEmpty();
      c.onFailure(new Error('boom'));
      expect(c.emptyStreak).toBe(0);
    });

    // --- Rate limiting / Retry-After ---------------------------------------

    it('treats Retry-After as a floor on the next delay', () => {
      const c = build();
      c.onFailure({ status: 429, headers: { 'retry-after': '300' } });
      expect(c.retryAfterMs).toBe(300_000);
      // Exponential backoff alone would only ask for 2000ms.
      expect(c.nextDelay().delayMs).toBe(300_000);
    });

    it('keeps a Retry-After floor even when it exceeds maxDelayMs', () => {
      // maxDelayMs must not truncate Horizon's cool-down, or we would retry
      // straight back into the rate limit.
      const c = build({ maxDelayMs: 10_000, maxRetryAfterMs: 3_600_000 });
      c.onFailure({ status: 429, headers: { 'retry-after': '1800' } });
      expect(c.nextDelay().delayMs).toBe(1_800_000);
    });

    it('does not let a stale Retry-After persist after a success', () => {
      const c = build();
      c.onFailure({ status: 429, headers: { 'retry-after': '300' } });
      c.onSuccess();
      expect(c.retryAfterMs).toBe(0);
      expect(c.nextDelay().delayMs).toBe(1_000);
    });

    it('clears the Retry-After floor on a non-429 failure', () => {
      const c = build();
      c.onFailure({ status: 429, headers: { 'retry-after': '300' } });
      c.onFailure(new Error('connection reset'));
      expect(c.retryAfterMs).toBe(0);
    });

    it('still escalates on repeated rate limits', () => {
      const c = build();
      c.onFailure({ status: 429, headers: { 'retry-after': '0' } });
      expect(c.nextDelay().nominalMs).toBe(2_000);
      c.onFailure({ status: 429, headers: { 'retry-after': '0' } });
      expect(c.nextDelay().nominalMs).toBe(4_000);
    });

    // --- Bookkeeping -------------------------------------------------------

    it('always returns a delay of at least 1ms', () => {
      const c = build({ baseDelayMs: 1, jitter: 'full', random: () => 0 });
      expect(c.nextDelay().delayMs).toBeGreaterThanOrEqual(1);
    });

    it('reset() clears every counter', () => {
      const c = build();
      c.onFailure({ status: 429, headers: { 'retry-after': '300' } });
      c.onEmpty();
      c.reset();
      expect(c.failureAttempt).toBe(0);
      expect(c.emptyStreak).toBe(0);
      expect(c.retryAfterMs).toBe(0);
      expect(c.nextDelay().delayMs).toBe(1_000);
    });

    it('currentDelayMs mirrors nextDelay().delayMs', () => {
      const c = build();
      c.onFailure();
      expect(c.currentDelayMs()).toBe(c.nextDelay().delayMs);
    });

    it('falls back to defaults for non-numeric overrides', () => {
      const c = createBackoffController({ baseDelayMs: 'abc', jitter: 'none' });
      expect(c.config.baseDelayMs).toBe(BACKOFF_DEFAULTS.baseDelayMs);
      expect(c.nextDelay().delayMs).toBe(BACKOFF_DEFAULTS.baseDelayMs);
    });

    it('reports the attempt and jitter contribution', () => {
      const c = build({ jitter: 'equal', random: () => 1 });
      c.onFailure();
      const info = c.nextDelay();
      expect(info.attempt).toBe(1);
      expect(info.nominalMs).toBe(2_000);
      expect(info.delayMs).toBe(2_000);
      expect(info.jitterMs).toBe(0);
    });

    it('produces a distinct delay on each draw so retries desynchronise', () => {
      const c = createBackoffController({
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        jitter: 'equal',
        random: sequence(0, 0.25, 0.5, 0.75, 0.99),
      });
      const delays = Array.from({ length: 5 }, () => c.nextDelay().delayMs);
      expect(new Set(delays).size).toBe(5);
      delays.forEach((d) => {
        expect(d).toBeGreaterThanOrEqual(500);
        expect(d).toBeLessThanOrEqual(1_000);
      });
    });
  });
});

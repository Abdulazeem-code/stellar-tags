// ---------------------------------------------------------------------------
// Tests for the Horizon listener's polling loop (#675)
//
// Verifies that the loop applies exponential backoff with jitter, honours
// Retry-After on 429s, and backs off on empty responses — the behaviour the
// issue asks for — instead of hammering Horizon on a fixed interval.
// ---------------------------------------------------------------------------

jest.mock('../src/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  httpLogger: (req, res, next) => next(),
}));

const mockPrisma = {
  user: { findMany: jest.fn() },
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../prismaClient', () => ({ prisma: mockPrisma }));

jest.mock('../src/db', () => ({
  poolGet: jest.fn(),
  poolRun: jest.fn(),
}));

jest.mock('../src/webhookWorker', () => ({
  dispatchPaymentWebhooks: jest.fn().mockResolvedValue(undefined),
  startWebhookWorker: jest.fn(),
  closeWebhookQueue: jest.fn().mockResolvedValue(undefined),
}));

// A breaker that never trips on its own, so each cycle is driven explicitly.
const mockBreaker = { fire: jest.fn() };

jest.mock('../src/services/stellarService', () => ({
  horizon: {
    payments: () => ({
      forAccount: () => ({
        cursor: () => ({ stream: (options) => mockStream(options) }),
      }),
    }),
  },
  createBreaker: jest.fn(() => mockBreaker),
  HORIZON_BASE: 'https://horizon-testnet.stellar.org',
  HORIZON_NETWORK: 'testnet',
}));

/** Records every stream opened and lets a test drive its callbacks. */
let mockStream = () => () => {};

const ACCOUNTS = {
  alice: { address: 'G_ALICE' },
  bob: { address: 'G_BOB' },
};

describe('horizonListener poll loop', () => {
  let listener;
  let env;

  beforeEach(() => {
    // Small intervals keep the fake-timer advances readable.
    env = { ...process.env };
    process.env.POLL_INTERVAL_MS = '1000';
    process.env.POLL_MAX_INTERVAL_MS = '8000';
    process.env.STREAM_RECONNECT_BASE_MS = '1000';
    process.env.STREAM_RECONNECT_MAX_MS = '8000';
    process.env.POLL_EMPTY_THRESHOLD = '2';
    process.env.HORIZON_POLL_JITTER = 'none';

    mockPrisma.user.findMany.mockReset().mockResolvedValue([ACCOUNTS.alice]);
    mockBreaker.fire.mockReset().mockResolvedValue(true);
    mockStream = jest.fn(() => jest.fn());
    listener = require('../horizonListener');
  });

  afterEach(() => {
    listener.stopPolling();
    jest.clearAllTimers();
    jest.useRealTimers();
    process.env = env;
    jest.resetModules();
  });

  describe('configuration', () => {
    it('reads the base and ceiling poll intervals from the environment', () => {
      expect(listener.POLL_INTERVAL_MS).toBe(1_000);
      expect(listener.POLL_MAX_INTERVAL_MS).toBe(8_000);
      expect(listener.STREAM_RECONNECT_BASE_MS).toBe(1_000);
    });

    it('probes the same Horizon base the SDK client uses', () => {
      expect(listener.HORIZON_URL).toBe('https://horizon-testnet.stellar.org');
    });
  });

  describe('healthy steady state', () => {
    it('re-polls at the base interval and opens a stream per account', async () => {
      await listener.runPollCycle();

      expect(mockBreaker.fire).toHaveBeenCalledTimes(1);
      expect(mockStream).toHaveBeenCalledTimes(1);
      expect(listener.activeStreams.has('G_ALICE')).toBe(true);

      // Healthy cycle -> backoff stays at the base delay.
      expect(listener.pollBackoff.failureAttempt).toBe(0);
      expect(listener.pollBackoff.nextDelay().delayMs).toBe(1_000);
    });

    it('does not reopen a stream it already holds', async () => {
      await listener.runPollCycle();
      await listener.runPollCycle();
      await listener.runPollCycle();

      expect(mockStream).toHaveBeenCalledTimes(1);
    });

    it('does not slow down when there is nothing new to discover', async () => {
      // Same account every cycle: the common production steady state.
      for (let i = 0; i < 5; i += 1) {
        await listener.runPollCycle();
      }
      expect(listener.pollBackoff.failureAttempt).toBe(0);
      expect(listener.pollBackoff.emptyStreak).toBe(0);
    });

    it('closes the stream when an account is deregistered', async () => {
      const close = jest.fn();
      mockStream.mockReturnValue(close);

      await listener.runPollCycle();
      expect(listener.activeStreams.has('G_ALICE')).toBe(true);

      mockPrisma.user.findMany.mockResolvedValue([ACCOUNTS.bob]);
      const summary = await listener.syncWatchedAccounts();

      expect(close).toHaveBeenCalled();
      expect(listener.activeStreams.has('G_ALICE')).toBe(false);
      expect(listener.activeStreams.has('G_BOB')).toBe(true);
      expect(summary).toMatchObject({ closed: 1, opened: 1, accounts: 1 });
    });
  });

  describe('backoff on failures', () => {
    it('backs off exponentially when Horizon is unreachable', async () => {
      mockBreaker.fire.mockRejectedValue(new Error('ECONNREFUSED'));

      const delays = [];
      for (let i = 0; i < 4; i += 1) {
        await listener.runPollCycle();
        delays.push(listener.pollBackoff.nextDelay().delayMs);
      }

      // 2s, 4s, 8s, then pinned at the 8s ceiling.
      expect(delays).toEqual([2_000, 4_000, 8_000, 8_000]);
    });

    it('never queries the database while the health check is failing', async () => {
      mockBreaker.fire.mockRejectedValue(new Error('down'));

      await listener.runPollCycle();

      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
      expect(mockStream).not.toHaveBeenCalled();
    });

    it('backs off when the database query fails', async () => {
      mockPrisma.user.findMany.mockRejectedValue(new Error('db down'));

      await listener.runPollCycle();
      expect(listener.pollBackoff.failureAttempt).toBe(1);

      await listener.runPollCycle();
      expect(listener.pollBackoff.failureAttempt).toBe(2);
    });

    it('recovers to the base interval once Horizon comes back', async () => {
      mockBreaker.fire.mockRejectedValue(new Error('down'));
      await listener.runPollCycle();
      await listener.runPollCycle();
      expect(listener.pollBackoff.nextDelay().delayMs).toBe(4_000);

      mockBreaker.fire.mockResolvedValue(true);
      await listener.runPollCycle();

      expect(listener.pollBackoff.failureAttempt).toBe(0);
      expect(listener.pollBackoff.nextDelay().delayMs).toBe(1_000);
    });
  });

  describe('backoff on empty responses', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue([]);
    });

    it('holds the base interval for the first empty cycle', async () => {
      await listener.runPollCycle();
      expect(listener.pollBackoff.nextDelay().delayMs).toBe(1_000);
    });

    it('stretches the interval once the empty threshold is crossed', async () => {
      // Threshold is 2 in this suite.
      await listener.runPollCycle();
      await listener.runPollCycle();

      expect(listener.pollBackoff.emptyStreak).toBe(2);
      expect(listener.pollBackoff.nextDelay().delayMs).toBe(2_000);

      await listener.runPollCycle();
      expect(listener.pollBackoff.nextDelay().delayMs).toBe(4_000);
    });

    it('resets the empty streak as soon as an account appears', async () => {
      await listener.runPollCycle();
      await listener.runPollCycle();
      expect(listener.pollBackoff.emptyStreak).toBe(2);

      mockPrisma.user.findMany.mockResolvedValue([ACCOUNTS.alice]);
      await listener.runPollCycle();

      expect(listener.pollBackoff.emptyStreak).toBe(0);
      expect(listener.pollBackoff.nextDelay().delayMs).toBe(1_000);
    });
  });

  describe('rate limiting (HTTP 429)', () => {
    it('waits at least as long as the Retry-After header demands', async () => {
      const rateLimited = new Error('Horizon rate limited (HTTP 429)');
      rateLimited.status = 429;
      rateLimited.headers = new Headers({ 'retry-after': '30' });
      mockBreaker.fire.mockRejectedValue(rateLimited);

      await listener.runPollCycle();

      // Exponential backoff alone would ask for 2s; Retry-After wins.
      expect(listener.pollBackoff.retryAfterMs).toBe(30_000);
      expect(listener.pollBackoff.nextDelay().delayMs).toBe(30_000);
    });

    it('keeps honouring Retry-After across consecutive 429s', async () => {
      const rateLimited = new Error('Horizon rate limited (HTTP 429)');
      rateLimited.status = 429;
      rateLimited.headers = new Headers({ 'retry-after': '60' });
      mockBreaker.fire.mockRejectedValue(rateLimited);

      for (let i = 0; i < 3; i += 1) {
        await listener.runPollCycle();
        expect(listener.pollBackoff.nextDelay().delayMs).toBe(60_000);
      }
    });

    it('drops the Retry-After floor after a successful cycle', async () => {
      const rateLimited = new Error('Horizon rate limited (HTTP 429)');
      rateLimited.status = 429;
      rateLimited.headers = new Headers({ 'retry-after': '30' });
      mockBreaker.fire.mockRejectedValue(rateLimited);

      await listener.runPollCycle();
      expect(listener.pollBackoff.nextDelay().delayMs).toBe(30_000);

      mockBreaker.fire.mockResolvedValue(true);
      await listener.runPollCycle();

      expect(listener.pollBackoff.retryAfterMs).toBe(0);
      expect(listener.pollBackoff.nextDelay().delayMs).toBe(1_000);
    });

    it('does not open streams when rate limited', async () => {
      const rateLimited = new Error('Too Many Requests');
      rateLimited.status = 429;
      mockBreaker.fire.mockRejectedValue(rateLimited);

      await listener.runPollCycle();

      expect(mockStream).not.toHaveBeenCalled();
      expect(listener.activeStreams.size).toBe(0);
    });
  });

  describe('SSE stream lifecycle', () => {
    it('closes the dead stream before scheduling a reconnect', () => {
      const close = jest.fn();
      let captured;
      mockStream.mockImplementation((options) => {
        captured = options;
        return close;
      });

      listener.watchAccount('G_ALICE');
      expect(listener.activeStreams.has('G_ALICE')).toBe(true);

      captured.onerror(new Error('stream died'));

      // The SDK's EventSource reconnects on its own, so leaving it open would
      // let the next cycle open a duplicate stream for the same account.
      expect(close).toHaveBeenCalledTimes(1);
      expect(listener.activeStreams.has('G_ALICE')).toBe(false);
    });

    it('schedules a jittered reconnect after a stream error', () => {
      let captured;
      mockStream.mockImplementation((options) => {
        captured = options;
        return jest.fn();
      });

      listener.watchAccount('G_ALICE');
      captured.onerror(new Error('stream died'));

      expect(listener.reconnectTimers.has('G_ALICE')).toBe(true);
      expect(listener.streamBackoffs.get('G_ALICE').failureAttempt).toBe(1);
    });

    it('escalates the reconnect delay on repeated stream failures', () => {
      let captured;
      mockStream.mockImplementation((options) => {
        captured = options;
        return jest.fn();
      });

      const backoff = () => listener.streamBackoffs.get('G_ALICE');

      listener.watchAccount('G_ALICE');
      captured.onerror(new Error('down'));
      expect(backoff().nextDelay().nominalMs).toBe(2_000);

      listener.watchAccount('G_ALICE');
      captured.onerror(new Error('down'));
      expect(backoff().nextDelay().nominalMs).toBe(4_000);

      listener.watchAccount('G_ALICE');
      captured.onerror(new Error('down'));
      expect(backoff().nextDelay().nominalMs).toBe(8_000);

      // ... and is capped, not unbounded.
      listener.watchAccount('G_ALICE');
      captured.onerror(new Error('down'));
      expect(backoff().nextDelay().delayMs).toBeLessThanOrEqual(8_000);
    });

    it('honours Retry-After on a rate-limited stream', () => {
      let captured;
      mockStream.mockImplementation((options) => {
        captured = options;
        return jest.fn();
      });

      listener.watchAccount('G_ALICE');
      const error = new Error('Too Many Requests');
      error.status = 429;
      error.headers = new Headers({ 'retry-after': '45' });
      captured.onerror(error);

      const backoff = listener.streamBackoffs.get('G_ALICE');
      expect(backoff.retryAfterMs).toBe(45_000);
      expect(backoff.nextDelay().delayMs).toBe(45_000);
    });

    it('actually reopens the stream when the reconnect timer fires', () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      let captured;
      mockStream.mockImplementation((options) => {
        captured = options;
        return jest.fn();
      });

      listener.watchAccount('G_ALICE');
      captured.onerror(new Error('stream died'));
      expect(mockStream).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(2_000);

      expect(mockStream).toHaveBeenCalledTimes(2);
      expect(listener.activeStreams.has('G_ALICE')).toBe(true);
      expect(listener.reconnectTimers.has('G_ALICE')).toBe(false);
    });

    it('resets the reconnect backoff once the stream delivers a message', () => {
      let captured;
      mockStream.mockImplementation((options) => {
        captured = options;
        return jest.fn();
      });

      listener.watchAccount('G_ALICE');
      captured.onerror(new Error('down'));
      expect(listener.streamBackoffs.get('G_ALICE').failureAttempt).toBe(1);

      listener.watchAccount('G_ALICE');
      captured.onmessage({ type: 'payment', type_i: 1, to: 'G_ALICE' });

      expect(listener.streamBackoffs.get('G_ALICE').failureAttempt).toBe(0);
    });

    it('ignores a late error from a stream that was already closed', () => {
      const callbacks = [];
      mockStream.mockImplementation((options) => {
        callbacks.push(options);
        return jest.fn();
      });

      listener.watchAccount('G_ALICE'); // stream A
      listener.closeStream('G_ALICE'); // A disposed, no longer in activeStreams
      listener.watchAccount('G_ALICE'); // stream B
      expect(listener.activeStreams.has('G_ALICE')).toBe(true);

      // A's connection tears down asynchronously and reports an error. It must
      // not disturb the healthy replacement or schedule a redundant reconnect.
      callbacks[0].onerror(new Error('late teardown'));

      expect(listener.activeStreams.has('G_ALICE')).toBe(true);
      expect(listener.reconnectTimers.has('G_ALICE')).toBe(false);
      expect(mockStream).toHaveBeenCalledTimes(2);
    });

    it('forgets reconnect state for a deregistered account', async () => {
      let captured;
      mockStream.mockImplementation((options) => {
        captured = options;
        return jest.fn();
      });

      listener.watchAccount('G_ALICE');
      captured.onerror(new Error('down'));
      expect(listener.streamBackoffs.has('G_ALICE')).toBe(true);
      expect(listener.reconnectTimers.has('G_ALICE')).toBe(true);

      listener.forgetAccount('G_ALICE', 'account removed');

      expect(listener.streamBackoffs.has('G_ALICE')).toBe(false);
      expect(listener.reconnectTimers.has('G_ALICE')).toBe(false);
    });

    it('cancels a pending reconnect when the poll loop wins the race', () => {
      let captured;
      mockStream.mockImplementation((options) => {
        captured = options;
        return jest.fn();
      });

      listener.watchAccount('G_ALICE');
      captured.onerror(new Error('down'));
      expect(listener.reconnectTimers.has('G_ALICE')).toBe(true);

      listener.watchAccount('G_ALICE');
      expect(listener.reconnectTimers.has('G_ALICE')).toBe(false);
    });
  });

  describe('probeHorizon', () => {
    afterEach(() => {
      delete global.fetch;
    });

    const ok = (extra = {}) => ({ ok: true, status: 200, ...extra });

    it('resolves when Horizon is reachable', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok());
      await expect(listener.probeHorizon()).resolves.toBe(true);
    });

    it('queries a cheap ledger endpoint on the configured Horizon base', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok());
      await listener.probeHorizon();

      expect(global.fetch).toHaveBeenCalledWith(
        'https://horizon-testnet.stellar.org/ledgers?limit=1',
        expect.objectContaining({ headers: { Accept: 'application/json' } }),
      );
    });

    // The probe exists mainly so a 429 stays identifiable: the SDK's
    // NetworkError throws the status away, which would make a rate limit
    // indistinguishable from an outage and forfeit the Retry-After hint.
    it('surfaces a 429 as a rate-limit error carrying Retry-After', async () => {
      const headers = new Headers({ 'retry-after': '45' });
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429, headers });

      await expect(listener.probeHorizon()).rejects.toMatchObject({
        status: 429,
        headers,
      });
    });

    it('surfaces other HTTP failures with their status', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 503, headers: new Headers() });

      await expect(listener.probeHorizon()).rejects.toMatchObject({ status: 503 });
    });

    it('propagates a network failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
      await expect(listener.probeHorizon()).rejects.toThrow('ECONNRESET');
    });
  });

  describe('main', () => {
    it('starts the webhook worker and runs a first poll cycle', async () => {
      const { startWebhookWorker } = require('../src/webhookWorker');
      await listener.main();

      expect(startWebhookWorker).toHaveBeenCalledTimes(1);
      expect(mockBreaker.fire).toHaveBeenCalledTimes(1);
      expect(listener.activeStreams.has('G_ALICE')).toBe(true);
    });
  });

  describe('payment dispatch', () => {
    it('forwards real payments to the webhook dispatcher and ignores other ops', () => {
      const { dispatchPaymentWebhooks } = require('../src/webhookWorker');
      let captured;
      mockStream.mockImplementation((options) => {
        captured = options;
        return jest.fn();
      });

      listener.watchAccount('G_ALICE');

      captured.onmessage({ type: 'create_account', type_i: 0, to: 'G_ALICE' });
      captured.onmessage({ type: 'path_payment_strict_receive', type_i: 2, to: 'G_ALICE' });
      expect(dispatchPaymentWebhooks).not.toHaveBeenCalled();

      captured.onmessage({
        type: 'payment',
        type_i: 1,
        to: 'G_ALICE',
        amount: '10',
        asset_type: 'native',
        transaction_hash: 'abc',
      });

      expect(dispatchPaymentWebhooks).toHaveBeenCalledTimes(1);
      expect(dispatchPaymentWebhooks).toHaveBeenCalledWith(
        expect.objectContaining({
          payment: expect.objectContaining({ transaction_hash: 'abc' }),
        }),
      );
    });

    it('logs a failed webhook dispatch instead of crashing the stream', async () => {
      const { dispatchPaymentWebhooks } = require('../src/webhookWorker');
      dispatchPaymentWebhooks.mockRejectedValueOnce(new Error('queue down'));
      let captured;
      mockStream.mockImplementation((options) => {
        captured = options;
        return jest.fn();
      });

      listener.watchAccount('G_ALICE');
      captured.onmessage({
        type: 'payment',
        type_i: 1,
        to: 'G_ALICE',
        transaction_hash: 'abc',
      });

      await new Promise((resolve) => setImmediate(resolve));
      const { logger } = require('../src/logger');
      expect(
        logger.error.mock.calls.some(([msg]) =>
          String(msg).includes('Webhook dispatch failed'),
        ),
      ).toBe(true);
    });
  });

  describe('scheduling', () => {
    // A cycle resolves through several microtasks before it re-arms its timer,
    // so advancing the clock has to be interleaved with a macrotask flush.
    const advance = async (ms) => {
      jest.advanceTimersByTime(ms);
      await new Promise((resolve) => setImmediate(resolve));
    };

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    });

    it('keeps re-arming the timer instead of using a fixed interval', async () => {
      mockBreaker.fire.mockResolvedValue(true);
      await listener.runPollCycle();
      expect(mockBreaker.fire).toHaveBeenCalledTimes(1);

      // Base interval cycle: re-arms itself, so both windows must fire.
      await advance(1_000);
      expect(mockBreaker.fire).toHaveBeenCalledTimes(2);
      await advance(1_000);
      expect(mockBreaker.fire).toHaveBeenCalledTimes(3);
    });

    it('leaves a longer gap after a failure, proving the interval is dynamic', async () => {
      mockBreaker.fire.mockRejectedValue(new Error('down'));
      // First failure doubles the wait from 1s to 2s.
      await listener.runPollCycle();
      mockBreaker.fire.mockClear();

      // A fixed setInterval would have fired here; the backoff must not.
      await advance(1_000);
      expect(mockBreaker.fire).not.toHaveBeenCalled();

      await advance(1_000);
      expect(mockBreaker.fire).toHaveBeenCalledTimes(1);
    });

    it('keeps at most one poll timer pending', async () => {
      // A cycle kicked outside the timer must not stack a second one and double
      // the polling rate.
      await listener.runPollCycle();
      await listener.runPollCycle();
      await listener.runPollCycle();
      mockBreaker.fire.mockClear();

      await advance(1_000);
      expect(mockBreaker.fire).toHaveBeenCalledTimes(1);
    });

    it('logs the delay it actually schedules, not a second jittered draw', async () => {
      jest.useRealTimers();

      // Turn jitter on so a second draw would produce a visibly different
      // number, then capture the delay the poll timer is actually armed with.
      jest.resetModules();
      process.env.HORIZON_POLL_JITTER = 'equal';
      // resetModules re-runs the logger mock factory, so re-require it to get
      // the same instance the freshly loaded listener will write to.
      const { logger } = require('../src/logger');
      const jittered = require('../horizonListener');

      mockPrisma.user.findMany.mockResolvedValue([]);
      const timerSpy = jest.spyOn(global, 'setTimeout');
      logger.info.mockClear();

      await jittered.runPollCycle();
      // Base is 1000ms with equal jitter, so the poll timer lands in [500, 1000].
      // The health probe's abort timer is 5000ms and must not be confused for it.
      const armed = timerSpy.mock.calls
        .map(([, ms]) => ms)
        .filter((ms) => ms >= 400 && ms <= 1_100);
      timerSpy.mockRestore();

      expect(armed).toHaveLength(1);
      const announced = logger.info.mock.calls
        .map(([msg]) => String(msg))
        .find((msg) => msg.includes('Next Horizon poll in'));

      expect(announced).toContain(`${Math.round(armed[0] / 1000)}s`);

      jittered.stopPolling();
    });

    it('does not overlap cycles when a cycle is still in flight', async () => {
      let release;
      mockBreaker.fire.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );

      const first = listener.runPollCycle();
      // A second entry while the first is pending must be a no-op.
      const second = listener.runPollCycle();
      release(true);
      await Promise.all([first, second]);

      expect(mockBreaker.fire).toHaveBeenCalledTimes(1);
    });

    it('stopPolling() clears the pending timer', async () => {
      await listener.runPollCycle();
      listener.stopPolling();
      mockBreaker.fire.mockClear();

      await advance(60_000);
      expect(mockBreaker.fire).not.toHaveBeenCalled();
    });
  });
});

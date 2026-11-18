'use strict';

const {
  CB_STATES,
  CONSECUTIVE_FAILURE_THRESHOLD,
  CONSECUTIVE_SUCCESS_THRESHOLD,
  PROBE_INTERVAL_MS,
  getDestinationDomain,
  canQueueDelivery,
  acquireProbeSlot,
  handleDeliverySuccess,
  handleDeliveryFailure,
  recordDeliveryMetrics,
  getDeliveryMetrics,
  consumeToken,
  calculateExponentialBackoff,
  alertMerchantCircuitBreakerOpen,
  sendProbeRequest,
  runProbeCycle,
  resetCircuitBreaker,
  clearMemoryCache,
  DASHBOARD_NOTIFICATION_CHANNEL,
} = require('../src/services/webhookService');

describe('Webhook Circuit Breaker & Rate Limiter Service', () => {
  beforeEach(() => {
    clearMemoryCache();
    jest.clearAllMocks();
  });

  describe('Destination domain extraction', () => {
    test('extracts hostname from full URLs', () => {
      expect(getDestinationDomain('https://api.merchant.com/v1/webhook')).toBe('api.merchant.com');
      expect(getDestinationDomain('http://localhost:3000/callback')).toBe('localhost');
      expect(getDestinationDomain('invalid-url')).toBe('unknown');
      expect(getDestinationDomain(null)).toBe('unknown');
    });
  });

  describe('Redis failure rates & response latency tracking', () => {
    test('tracks failure rates and response latency per destination domain', async () => {
      const mockStorage = new Map();
      const mockRedis = {
        pipeline: () => {
          const ops = [];
          const pipe = {
            hincrby: (k, f, v) => {
              ops.push(() => {
                const existing = mockStorage.get(`${k}:${f}`) || 0;
                const next = existing + v;
                mockStorage.set(`${k}:${f}`, next);
                return [null, next];
              });
              return pipe;
            },
            hset: (k, f, v) => {
              ops.push(() => {
                mockStorage.set(`${k}:${f}`, v);
                return [null, 1];
              });
              return pipe;
            },
            expire: () => {
              ops.push(() => [null, 1]);
              return pipe;
            },
            exec: async () => ops.map((fn) => fn()),
          };
          return pipe;
        },
        hset: jest.fn().mockResolvedValue(1),
        hgetall: jest.fn().mockImplementation(async (key) => {
          return {
            totalRequests: String(mockStorage.get(`${key}:totalRequests`) || 0),
            successRequests: String(mockStorage.get(`${key}:successRequests`) || 0),
            failedRequests: String(mockStorage.get(`${key}:failedRequests`) || 0),
            failureRate: '0.5000',
            avgLatencyMs: '120',
            lastLatencyMs: '150',
          };
        }),
      };

      const domain = 'store.acme.org';
      // Record 1 failure with 150ms latency
      await recordDeliveryMetrics(mockRedis, domain, { success: false, latencyMs: 150, statusCode: 504 });

      // Record 1 success with 90ms latency
      await recordDeliveryMetrics(mockRedis, domain, { success: true, latencyMs: 90, statusCode: 200 });

      const metrics = await getDeliveryMetrics(mockRedis, domain);
      expect(metrics.domain).toBe(domain);
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.avgLatencyMs).toBe(120);
    });

    test('tracks failure rates and latency in-memory when Redis is not configured', async () => {
      const domain = 'standalone.merchant.com';
      await recordDeliveryMetrics(null, domain, { success: true, latencyMs: 100, statusCode: 200 });
      await recordDeliveryMetrics(null, domain, { success: false, latencyMs: 300, statusCode: 500 });

      const metrics = await getDeliveryMetrics(null, domain);
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.successRequests).toBe(1);
      expect(metrics.failedRequests).toBe(1);
      expect(metrics.failureRate).toBe(0.5);
      expect(metrics.avgLatencyMs).toBe(200);
      expect(metrics.lastLatencyMs).toBe(300);
    });
  });

  describe('Circuit breaker tripping and active delivery queue halting', () => {
    test('trips circuit breaker to OPEN after 5 consecutive failures and halts active queueing', async () => {
      const domain = 'failing.merchant.io';
      const mockPrisma = {
        activityLog: {
          create: jest.fn().mockResolvedValue({ id: 'act-1' }),
        },
      };
      const mockRedis = {
        publish: jest.fn().mockResolvedValue(1),
      };

      // Initially closed and allowed
      const initialCheck = await canQueueDelivery(null, domain);
      expect(initialCheck.allowed).toBe(true);
      expect(initialCheck.state).toBe(CB_STATES.CLOSED);

      // Record 4 consecutive failures
      for (let i = 1; i <= 4; i += 1) {
        const record = await handleDeliveryFailure(null, domain, new Error('HTTP 500 Internal Server Error'), 50, {
          prisma: mockPrisma,
          merchantUsername: 'alice',
        });
        expect(record.state).toBe(CB_STATES.CLOSED);
        expect(record.consecutiveFailures).toBe(i);
      }

      // 5th failure trips breaker to OPEN
      const trippedRecord = await handleDeliveryFailure(null, domain, new Error('Gateway Timeout 504'), 80, {
        prisma: mockPrisma,
        merchantUsername: 'alice',
      });

      expect(trippedRecord.state).toBe(CB_STATES.OPEN);
      expect(trippedRecord.consecutiveFailures).toBe(5);

      // Active delivery queueing must now be HALTED
      const haltedCheck = await canQueueDelivery(null, domain);
      expect(haltedCheck.allowed).toBe(false);
      expect(haltedCheck.state).toBe(CB_STATES.OPEN);
      expect(haltedCheck.reason).toContain('Active queueing halted');
    });

    test('resets consecutive failure counter on success during CLOSED state', async () => {
      const domain = 'recovering-early.com';
      await handleDeliveryFailure(null, domain, new Error('500'), 50);
      await handleDeliveryFailure(null, domain, new Error('500'), 50);

      // Success resets failure count
      const record = await handleDeliverySuccess(null, domain, 60);
      expect(record.state).toBe(CB_STATES.CLOSED);
      expect(record.consecutiveFailures).toBe(0);
    });
  });

  describe('Merchant dashboard notification on OPEN', () => {
    test('alerts merchant via dashboard activity log and Redis pub/sub when breaker opens', async () => {
      const domain = 'alert.merchant.com';
      const mockPrisma = {
        activityLog: {
          create: jest.fn().mockResolvedValue({ id: 'alert-log-1' }),
        },
      };
      const mockRedis = {
        publish: jest.fn().mockResolvedValue(1),
      };

      // Trip the breaker with 5 failures
      for (let i = 1; i <= 5; i += 1) {
        await handleDeliveryFailure(null, domain, new Error('HTTP 503 Service Unavailable'), 100, {
          prisma: mockPrisma,
          merchantUsername: 'merchant_bob',
        });
      }

      // Check alert was recorded in Prisma activityLog
      expect(mockPrisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            username: 'merchant_bob',
            action: 'webhook.circuit_breaker_open',
            metadata: expect.objectContaining({
              domain,
              state: CB_STATES.OPEN,
            }),
          }),
        }),
      );

      // Test direct alertMerchantCircuitBreakerOpen call with Redis
      await alertMerchantCircuitBreakerOpen({
        domain,
        merchantUsername: 'merchant_bob',
        prisma: mockPrisma,
        redis: mockRedis,
        failures: 5,
      });

      expect(mockRedis.publish).toHaveBeenCalledWith(
        DASHBOARD_NOTIFICATION_CHANNEL,
        expect.stringContaining('CIRCUIT_BREAKER_OPEN'),
      );
    });
  });

  describe('Probing & recovery to CLOSED after 3 consecutive 200 OKs', () => {
    test('sends probe after cooldown and resets to CLOSED after 3 consecutive 200 OKs', async () => {
      const domain = 'probe-test.com';

      // 1. Force trip to OPEN
      for (let i = 0; i < 5; i += 1) {
        await handleDeliveryFailure(null, domain, new Error('HTTP 500'), 100);
      }

      // Cannot probe immediately because 60s cooldown has not elapsed
      const immediateCheck = await canQueueDelivery(null, domain);
      expect(immediateCheck.canProbe).toBe(false);

      // 2. Fast forward time by 60 seconds (PROBE_INTERVAL_MS)
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + PROBE_INTERVAL_MS + 1000);

      // Probe is now eligible!
      const eligibleCheck = await canQueueDelivery(null, domain);
      expect(eligibleCheck.canProbe).toBe(true);

      // Acquire probe slot (switches to HALF_OPEN)
      const probeAcquired = await acquireProbeSlot(null, domain);
      expect(probeAcquired).toBe(true);

      // While probe is in flight, regular queueing remains halted
      const probingCheck = await canQueueDelivery(null, domain);
      expect(probingCheck.allowed).toBe(false);
      expect(probingCheck.state).toBe(CB_STATES.HALF_OPEN);

      // Probe 1: Success (1/3)
      const rec1 = await handleDeliverySuccess(null, domain, 50);
      expect(rec1.state).toBe(CB_STATES.HALF_OPEN);
      expect(rec1.consecutiveSuccesses).toBe(1);

      // Acquire next probe
      await acquireProbeSlot(null, domain);
      // Probe 2: Success (2/3)
      const rec2 = await handleDeliverySuccess(null, domain, 50);
      expect(rec2.state).toBe(CB_STATES.HALF_OPEN);
      expect(rec2.consecutiveSuccesses).toBe(2);

      // Acquire 3rd probe
      await acquireProbeSlot(null, domain);
      // Probe 3: Success (3/3) -> Resets to CLOSED!
      const rec3 = await handleDeliverySuccess(null, domain, 50);
      expect(rec3.state).toBe(CB_STATES.CLOSED);
      expect(rec3.consecutiveFailures).toBe(0);
      expect(rec3.consecutiveSuccesses).toBe(0);

      // Normal queueing is now fully restored
      const restoredCheck = await canQueueDelivery(null, domain);
      expect(restoredCheck.allowed).toBe(true);
      expect(restoredCheck.state).toBe(CB_STATES.CLOSED);

      Date.now.mockRestore();
    });

    test('re-trips to OPEN if a probe fails during HALF_OPEN state', async () => {
      const domain = 'probe-fail.com';

      // Trip to OPEN
      for (let i = 0; i < 5; i += 1) {
        await handleDeliveryFailure(null, domain, new Error('500'), 50);
      }

      // Fast forward 60 seconds
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 60_000);

      await acquireProbeSlot(null, domain);

      // Probe 1 succeeds
      await handleDeliverySuccess(null, domain, 50);

      // Probe 2 fails!
      const failRecord = await handleDeliveryFailure(null, domain, new Error('HTTP 502 Bad Gateway'), 50);
      expect(failRecord.state).toBe(CB_STATES.OPEN);
      expect(failRecord.consecutiveSuccesses).toBe(0);

      Date.now.mockRestore();
    });

    test('sendProbeRequest executes probe and records success/failure', async () => {
      const webhook = {
        id: 'wh-probe-1',
        url: 'https://probe-runner.com/webhook',
        secret: 'sec',
        username: 'alice',
      };
      const mockSendWebhook = jest.fn().mockResolvedValue({ ok: true });

      const result = await sendProbeRequest(webhook, { sendWebhookFn: mockSendWebhook });
      expect(result.ok).toBe(true);
      expect(mockSendWebhook).toHaveBeenCalledWith(
        webhook.url,
        expect.objectContaining({ event: 'probe.health_check' }),
        webhook.secret,
      );
    });
  });

  describe('Token bucket rate limiting & exponential backpressure', () => {
    test('enforces rate limiting and computes backpressure delays', async () => {
      const domain = 'ratelimited.merchant.com';

      // First bursts within capacity should succeed
      for (let i = 0; i < 10; i += 1) {
        const result = await consumeToken(null, domain, 1);
        expect(result.allowed).toBe(true);
      }

      // 11th request exhausts capacity
      const exhausted = await consumeToken(null, domain, 1);
      expect(exhausted.allowed).toBe(false);
      expect(exhausted.retryAfterMs).toBeGreaterThan(0);

      // Backpressure delay exponential scaling
      expect(calculateExponentialBackoff(0)).toBe(1000);
      expect(calculateExponentialBackoff(1)).toBe(2000);
      expect(calculateExponentialBackoff(2)).toBe(4000);
      expect(calculateExponentialBackoff(3)).toBe(8000);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests for DB Pool Monitor
// ---------------------------------------------------------------------------

const mockLogger = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
};

// Mock the logger before the module is loaded
jest.mock('../src/logger', () => ({
  logger: mockLogger,
}));

describe('DB Pool Monitor', () => {
  let getPoolMetrics;
  let checkPool;
  let schedulePoolMonitoring;

  const mockPrisma = {
    $metrics: {
      json: jest.fn(),
    },
  };

  beforeAll(() => {
    const mod = require('../src/db-pool-monitor');
    getPoolMetrics = mod.getPoolMetrics;
    checkPool = mod.checkPool;
    schedulePoolMonitoring = mod.schedulePoolMonitoring;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('getPoolMetrics', () => {
    it('returns parsed pool metrics from Prisma', async () => {
      mockPrisma.$metrics.json.mockResolvedValue({
        counters: [],
        gauges: [],
        histograms: [],
        ecollections: [
          { key: 'prisma_client_pool_connections_active', value: 3, labels: {} },
          { key: 'prisma_client_pool_connections_idle', value: 7, labels: {} },
          { key: 'prisma_client_pool_connections_size', value: 10, labels: {} },
          { key: 'prisma_client_pool_waiters', value: 0, labels: {} },
        ],
      });

      const metrics = await getPoolMetrics(mockPrisma);
      expect(metrics).toEqual({ active: 3, idle: 7, size: 10, waiters: 0 });
    });

    it('defaults to 0 for missing metrics keys', async () => {
      mockPrisma.$metrics.json.mockResolvedValue({
        counters: [],
        gauges: [],
        histograms: [],
        ecollections: [],
      });

      const metrics = await getPoolMetrics(mockPrisma);
      expect(metrics).toEqual({ active: 0, idle: 0, size: 0, waiters: 0 });
    });

    it('returns null when $metrics throws', async () => {
      mockPrisma.$metrics.json.mockRejectedValue(new Error('Not available'));

      const metrics = await getPoolMetrics(mockPrisma);
      expect(metrics).toBeNull();
    });

    it('returns null when $metrics is not a function', async () => {
      const prismaWithoutMetrics = {};
      const metrics = await getPoolMetrics(prismaWithoutMetrics);
      expect(metrics).toBeNull();
    });
  });

  describe('checkPool', () => {
    it('logs warning when pool usage exceeds 80%', async () => {
      mockPrisma.$metrics.json.mockResolvedValue({
        counters: [],
        gauges: [],
        histograms: [],
        ecollections: [
          { key: 'prisma_client_pool_connections_active', value: 9, labels: {} },
          { key: 'prisma_client_pool_connections_idle', value: 1, labels: {} },
          { key: 'prisma_client_pool_connections_size', value: 10, labels: {} },
          { key: 'prisma_client_pool_waiters', value: 0, labels: {} },
        ],
      });

      await checkPool(mockPrisma);

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn.mock.calls[0][0]).toContain('near exhaustion');
      expect(mockLogger.warn.mock.calls[0][0]).toContain('9/10');
      expect(mockLogger.warn.mock.calls[0][0]).toContain('90%');
    });

    it('does not log when pool usage is below threshold', async () => {
      mockPrisma.$metrics.json.mockResolvedValue({
        counters: [],
        gauges: [],
        histograms: [],
        ecollections: [
          { key: 'prisma_client_pool_connections_active', value: 5, labels: {} },
          { key: 'prisma_client_pool_connections_idle', value: 5, labels: {} },
          { key: 'prisma_client_pool_connections_size', value: 10, labels: {} },
          { key: 'prisma_client_pool_waiters', value: 0, labels: {} },
        ],
      });

      await checkPool(mockPrisma);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('logs warning when there are waiters regardless of pool usage', async () => {
      mockPrisma.$metrics.json.mockResolvedValue({
        counters: [],
        gauges: [],
        histograms: [],
        ecollections: [
          { key: 'prisma_client_pool_connections_active', value: 3, labels: {} },
          { key: 'prisma_client_pool_connections_idle', value: 7, labels: {} },
          { key: 'prisma_client_pool_connections_size', value: 10, labels: {} },
          { key: 'prisma_client_pool_waiters', value: 2, labels: {} },
        ],
      });

      await checkPool(mockPrisma);

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn.mock.calls[0][0]).toContain('queued waiting');
      expect(mockLogger.warn.mock.calls[0][0]).toContain('2 request');
    });

    it('does not warn when metrics are unavailable', async () => {
      mockPrisma.$metrics.json.mockRejectedValue(new Error('Not available'));

      await checkPool(mockPrisma);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('does not warn when pool size is zero', async () => {
      mockPrisma.$metrics.json.mockResolvedValue({
        counters: [],
        gauges: [],
        histograms: [],
        ecollections: [
          { key: 'prisma_client_pool_connections_active', value: 0, labels: {} },
          { key: 'prisma_client_pool_connections_idle', value: 0, labels: {} },
          { key: 'prisma_client_pool_connections_size', value: 0, labels: {} },
          { key: 'prisma_client_pool_waiters', value: 0, labels: {} },
        ],
      });

      await checkPool(mockPrisma);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('logs both warnings when usage is high and waiters exist', async () => {
      mockPrisma.$metrics.json.mockResolvedValue({
        counters: [],
        gauges: [],
        histograms: [],
        ecollections: [
          { key: 'prisma_client_pool_connections_active', value: 10, labels: {} },
          { key: 'prisma_client_pool_connections_idle', value: 0, labels: {} },
          { key: 'prisma_client_pool_connections_size', value: 10, labels: {} },
          { key: 'prisma_client_pool_waiters', value: 3, labels: {} },
        ],
      });

      await checkPool(mockPrisma);

      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn.mock.calls[0][0]).toContain('near exhaustion');
      expect(mockLogger.warn.mock.calls[1][0]).toContain('queued waiting');
    });
  });

  describe('schedulePoolMonitoring', () => {
    it('runs an immediate check and schedules periodic checks', () => {
      mockPrisma.$metrics.json.mockResolvedValue({
        counters: [],
        gauges: [],
        histograms: [],
        ecollections: [
          { key: 'prisma_client_pool_connections_active', value: 9, labels: {} },
          { key: 'prisma_client_pool_connections_idle', value: 1, labels: {} },
          { key: 'prisma_client_pool_connections_size', value: 10, labels: {} },
          { key: 'prisma_client_pool_waiters', value: 0, labels: {} },
        ],
      });

      // Clear previous handler calls before starting
      mockLogger.warn.mockClear();
      mockLogger.info.mockClear();

      const handle = schedulePoolMonitoring(mockPrisma);

      // Should run an immediate check (async, so flush microtasks)
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Pool monitor started')
      );

      // Advance time by one interval and verify another check ran
      return new Promise((resolve) => {
        // The immediate check is async — wait for it, then advance time
        setImmediate(() => {
          // The first immediate check would have run
          mockLogger.warn.mockClear();

          // Trigger the next interval check
          jest.advanceTimersByTime(30_000);

          setImmediate(() => {
            // warn should be called again after the interval check
            expect(mockLogger.warn).toHaveBeenCalled();
            handle.stop();
            resolve();
          });
        });
      });
    });

    it('returns a handle that can be stopped', () => {
      mockPrisma.$metrics.json.mockResolvedValue({
        counters: [],
        gauges: [],
        histograms: [],
        ecollections: [],
      });

      mockLogger.info.mockClear();

      const handle = schedulePoolMonitoring(mockPrisma);
      expect(handle).toBeDefined();
      expect(handle.stop).toEqual(expect.any(Function));

      // Stop it and verify no more checks run after interval
      handle.stop();

      jest.advanceTimersByTime(60_000);

      // info should only have been called once (from startup)
      return new Promise((resolve) => {
        setImmediate(() => {
          expect(mockLogger.info).toHaveBeenCalledTimes(1);
          resolve();
        });
      });
    });
  });
});

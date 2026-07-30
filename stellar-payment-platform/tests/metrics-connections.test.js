const client = require('prom-client');

jest.mock('../src/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const { getMetrics, setMetricsSources } = require('../src/metrics');

const poolGauges = (metricsText) =>
  Object.fromEntries(
    metricsText
      .split('\n')
      .filter((line) => line.startsWith('stellar_tags_db_pool_') || line.startsWith('stellar_tags_redis_'))
      .map((line) => {
        const [name, value] = line.split(' ');
        return [name, Number(value)];
      }),
  );

const makePrisma = (gauges) => ({
  $metrics: { json: jest.fn().mockResolvedValue({ counters: [], histograms: [], gauges }) },
});

describe('Connection metrics', () => {
  afterEach(() => {
    setMetricsSources({ prisma: null, redisClient: null });
  });

  describe('Prisma pool gauges', () => {
    test('report the live pool snapshot', async () => {
      setMetricsSources({
        prisma: makePrisma([
          { key: 'prisma_pool_connections_busy', value: 4, labels: {} },
          { key: 'prisma_pool_connections_idle', value: 6, labels: {} },
          { key: 'prisma_pool_connections_open', value: 10, labels: {} },
          { key: 'prisma_client_queries_wait', value: 2, labels: {} },
        ]),
      });

      const values = poolGauges(await getMetrics());

      expect(values.stellar_tags_db_pool_connections_open).toBe(10);
      expect(values.stellar_tags_db_pool_connections_busy).toBe(4);
      expect(values.stellar_tags_db_pool_connections_idle).toBe(6);
      expect(values.stellar_tags_db_pool_queries_waiting).toBe(2);
    });

    test('re-read the pool on each scrape', async () => {
      const prisma = makePrisma([
        { key: 'prisma_pool_connections_open', value: 3, labels: {} },
      ]);
      setMetricsSources({ prisma });

      await getMetrics();
      const callsAfterFirstScrape = prisma.$metrics.json.mock.calls.length;
      await getMetrics();

      expect(callsAfterFirstScrape).toBeGreaterThan(0);
      expect(prisma.$metrics.json.mock.calls.length).toBeGreaterThan(callsAfterFirstScrape);
    });

    test('share one $metrics call across the gauges in a single scrape', async () => {
      const prisma = makePrisma([
        { key: 'prisma_pool_connections_open', value: 3, labels: {} },
      ]);
      setMetricsSources({ prisma });

      await getMetrics();

      expect(prisma.$metrics.json).toHaveBeenCalledTimes(1);
    });

    test('report zero when Prisma metrics are unavailable', async () => {
      setMetricsSources({
        prisma: { $metrics: { json: jest.fn().mockRejectedValue(new Error('not enabled')) } },
      });

      const values = poolGauges(await getMetrics());

      expect(values.stellar_tags_db_pool_connections_open).toBe(0);
      expect(values.stellar_tags_db_pool_connections_busy).toBe(0);
      expect(values.stellar_tags_db_pool_connections_idle).toBe(0);
      expect(values.stellar_tags_db_pool_queries_waiting).toBe(0);
    });

    test('report zero when no Prisma client is registered', async () => {
      const values = poolGauges(await getMetrics());

      expect(values.stellar_tags_db_pool_connections_open).toBe(0);
    });
  });

  describe('Redis gauge', () => {
    test('reports 1 while the client is ready', async () => {
      setMetricsSources({ redisClient: { isReady: true } });

      const values = poolGauges(await getMetrics());

      expect(values.stellar_tags_redis_connections_active).toBe(1);
    });

    test('reports 0 while the client is connecting or disconnected', async () => {
      setMetricsSources({ redisClient: { isReady: false } });

      const values = poolGauges(await getMetrics());

      expect(values.stellar_tags_redis_connections_active).toBe(0);
    });

    test('reports 0 when Redis is not configured', async () => {
      setMetricsSources({ redisClient: null });

      const values = poolGauges(await getMetrics());

      expect(values.stellar_tags_redis_connections_active).toBe(0);
    });
  });

  describe('Prometheus format', () => {
    test('documents each connection gauge with HELP and TYPE', async () => {
      const metricsText = await getMetrics();

      for (const name of [
        'stellar_tags_db_pool_connections_open',
        'stellar_tags_db_pool_connections_busy',
        'stellar_tags_db_pool_connections_idle',
        'stellar_tags_db_pool_queries_waiting',
        'stellar_tags_redis_connections_active',
      ]) {
        expect(metricsText).toContain(`# HELP ${name}`);
        expect(metricsText).toContain(`# TYPE ${name} gauge`);
      }
    });

    test('exposes memory and CPU metrics alongside them', async () => {
      const metricsText = await getMetrics();

      expect(metricsText).toContain('stellar_tags_process_resident_memory_bytes');
      expect(metricsText).toContain('stellar_tags_nodejs_heap_size_used_bytes');
      expect(metricsText).toContain('stellar_tags_process_cpu_user_seconds_total');
      expect(metricsText).toContain('stellar_tags_process_cpu_system_seconds_total');
    });
  });
});

afterAll(() => {
  client.register.clear();
});

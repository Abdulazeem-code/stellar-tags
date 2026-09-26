const request = require('supertest');
const express = require('express');

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
}));

jest.mock('../prismaClient', () => ({
  prisma: { $queryRaw: jest.fn() },
}));

const { prisma } = require('../prismaClient');
const { HORIZON_BASE } = require('../src/services/stellarService');
const healthRoutes = require('../src/routes/v1/healthRoutes');

const buildApp = (redisClient = null) => {
  const app = express();
  app.use(healthRoutes(redisClient));
  return app;
};

let redisClient;

beforeEach(() => {
  jest.clearAllMocks();
  prisma.$queryRaw.mockResolvedValue([{ 1: 1 }]);
  redisClient = { ping: jest.fn().mockResolvedValue('PONG') };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
});

describe('GET /health', () => {
  test('returns 200 with every dependency up', async () => {
    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'UP',
      database: 'up',
      redis: 'up',
      horizon: 'up',
    });
    expect(res.body.timestamp).toEqual(expect.any(String));
  });

  test('probes PostgreSQL, Redis and Horizon', async () => {
    await request(buildApp(redisClient)).get('/health');

    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(redisClient.ping).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(HORIZON_BASE, expect.anything());
  });

  test('returns 503 when the database query fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('DOWN');
    expect(res.body.database).toBe('down');
    expect(res.body.message).toContain('Database unavailable');
  });

  test('returns 503 when the Redis PING fails', async () => {
    redisClient.ping.mockRejectedValue(new Error('not connected'));

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.redis).toBe('down');
    expect(res.body.message).toContain('Redis unavailable');
  });

  test('returns 503 when Horizon is unreachable', async () => {
    global.fetch.mockRejectedValue(new Error('ETIMEDOUT'));

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.horizon).toBe('down');
    expect(res.body.message).toContain('Horizon unavailable');
  });

  test('returns 503 when Horizon answers with a non-2xx status', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 502 });

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.horizon).toBe('down');
  });

  test('reports every failing dependency in one response', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('down'));
    redisClient.ping.mockRejectedValue(new Error('down'));
    global.fetch.mockRejectedValue(new Error('down'));

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      database: 'down',
      redis: 'down',
      horizon: 'down',
    });
  });

  test('reports Redis as not configured and stays healthy without it', async () => {
    const res = await request(buildApp(null)).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.redis).toBe('not configured');
  });

  test('aborts the Horizon probe once the timeout elapses', async () => {
    await request(buildApp(redisClient)).get('/health');

    const [, options] = global.fetch.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });
});

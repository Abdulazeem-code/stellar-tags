'use strict';

/**
 * Unit tests for src/routes/v1/statsRoutes.js (GET /stats).
 */

const request = require('supertest');
const express = require('express');

jest.mock('../prismaClient', () => ({
  prisma: {},
}));

jest.mock('../src/db', () => ({
  poolGet: jest.fn(),
  etagCache: (req, res, next) => next(),
}));

jest.mock('../src/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const mockGetCachedStats = jest.fn();
jest.mock('../src/cache/statsCache', () => ({
  getCachedStats: (...args) => mockGetCachedStats(...args),
}));

const mockFetchAdminStats = jest.fn();
jest.mock('../src/services/statsService', () => ({
  fetchAdminStats: (...args) => mockFetchAdminStats(...args),
}));

const statsRoutes = require('../src/routes/v1/statsRoutes');

const buildApp = (redisClient) => {
  const app = express();
  app.use(statsRoutes(redisClient));
  // Mimic the production error handler so next(err) becomes a JSON response.
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  return app;
};

describe('GET /stats', () => {
  beforeEach(() => {
    mockGetCachedStats.mockReset();
    mockFetchAdminStats.mockReset();
  });

  it('returns cached stats with 200', async () => {
    mockGetCachedStats.mockResolvedValue({ total_users: 10, total_payments: 100 });

    const res = await request(buildApp({ isReady: true })).get('/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_users: 10, total_payments: 100 });
    expect(mockGetCachedStats).toHaveBeenCalledTimes(1);
    expect(mockFetchAdminStats).not.toHaveBeenCalled();
  });

  it('fetches fresh stats on a cache miss', async () => {
    mockGetCachedStats.mockImplementation(async (redis, fetchFn) => fetchFn());
    mockFetchAdminStats.mockResolvedValue({ total_users: 3 });

    const res = await request(buildApp(null)).get('/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_users: 3 });
    expect(mockFetchAdminStats).toHaveBeenCalledTimes(1);
  });

  it('propagates failures as a 500', async () => {
    mockGetCachedStats.mockRejectedValue(new Error('stats backend down'));

    const res = await request(buildApp(null)).get('/stats');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to retrieve platform statistics' });
  });
});
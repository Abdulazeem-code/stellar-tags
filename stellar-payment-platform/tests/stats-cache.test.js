'use strict';

/**
 * Unit tests for src/cache/statsCache.js.
 */

jest.mock('../src/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

const { logger } = require('../src/logger');
const {
  getCachedStats,
  invalidateStatsCache,
  STATS_CACHE_KEY,
  STATS_CACHE_TTL,
} = require('../src/cache/statsCache');

const fetchFn = jest.fn().mockResolvedValue({ total: 42 });

describe('getCachedStats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a cached result when Redis is ready', async () => {
    const redis = {
      isReady: true,
      get: jest.fn().mockResolvedValue(JSON.stringify({ total: 42 })),
      setEx: jest.fn(),
    };

    const result = await getCachedStats(redis, fetchFn);

    expect(result).toEqual({ total: 42 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fetches and stores on a cache miss', async () => {
    const redis = {
      isReady: true,
      get: jest.fn().mockResolvedValue(null),
      setEx: jest.fn().mockResolvedValue('OK'),
    };

    const result = await getCachedStats(redis, fetchFn);

    expect(result).toEqual({ total: 42 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(redis.setEx).toHaveBeenCalledWith(STATS_CACHE_KEY, STATS_CACHE_TTL, JSON.stringify({ total: 42 }));
  });

  it('falls through to fetchFn when Redis is unavailable', async () => {
    const result = await getCachedStats(null, fetchFn);
    expect(result).toEqual({ total: 42 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('logs and falls through when the Redis read fails', async () => {
    const redis = {
      isReady: true,
      get: jest.fn().mockRejectedValue(new Error('read failed')),
      setEx: jest.fn().mockResolvedValue('OK'),
    };

    const result = await getCachedStats(redis, fetchFn);

    expect(result).toEqual({ total: 42 });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('logs a write failure without rejecting', async () => {
    const redis = {
      isReady: true,
      get: jest.fn().mockResolvedValue(null),
      setEx: jest.fn().mockRejectedValue(new Error('write failed')),
    };

    const result = await getCachedStats(redis, fetchFn);

    expect(result).toEqual({ total: 42 });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('invalidateStatsCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes the stats key when Redis is ready', async () => {
    const redis = { isReady: true, del: jest.fn().mockResolvedValue(1) };
    await invalidateStatsCache(redis);
    expect(redis.del).toHaveBeenCalledWith([STATS_CACHE_KEY]);
  });

  it('is a no-op when Redis is not ready or missing', async () => {
    await invalidateStatsCache(null);
    await invalidateStatsCache({ isReady: false, del: jest.fn() });
  });

  it('logs and swallows deletion errors', async () => {
    const redis = { isReady: true, del: jest.fn().mockRejectedValue(new Error('gone')) };
    await invalidateStatsCache(redis);
    expect(logger.warn).toHaveBeenCalled();
  });
});
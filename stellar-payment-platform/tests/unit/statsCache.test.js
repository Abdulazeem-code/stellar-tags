'use strict';

const { getCachedStats, invalidateStatsCache, STATS_CACHE_KEY } = require('../../src/cache/statsCache');

const STATS_CACHE_TTL = 300;

describe('getCachedStats', () => {
  test('cache hit: redisClient.get returns JSON → fetchFn is NOT called, cached object returned', async () => {
    const cached = { total_registered_users: 10, active_tokens: 8 };
    const redisClient = {
      isReady: true,
      get: jest.fn().mockResolvedValue(JSON.stringify(cached)),
      setEx: jest.fn(),
    };
    const fetchFn = jest.fn();

    const result = await getCachedStats(redisClient, fetchFn);

    expect(redisClient.get).toHaveBeenCalledWith(STATS_CACHE_KEY);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result).toEqual(cached);
  });

  test('cache miss: redisClient.get returns null → fetchFn called, setEx called, result returned', async () => {
    const fresh = { total_registered_users: 5, active_tokens: 3 };
    const redisClient = {
      isReady: true,
      get: jest.fn().mockResolvedValue(null),
      setEx: jest.fn().mockResolvedValue('OK'),
    };
    const fetchFn = jest.fn().mockResolvedValue(fresh);

    const result = await getCachedStats(redisClient, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    // setEx is fire-and-forget; give it a tick to be called
    await Promise.resolve();
    expect(redisClient.setEx).toHaveBeenCalledWith(
      STATS_CACHE_KEY,
      STATS_CACHE_TTL,
      JSON.stringify(fresh),
    );
    expect(result).toEqual(fresh);
  });

  test('Redis not ready: fetchFn called directly, no Redis calls made', async () => {
    const fresh = { total_registered_users: 2, active_tokens: 1 };
    const redisClient = {
      isReady: false,
      get: jest.fn(),
      setEx: jest.fn(),
    };
    const fetchFn = jest.fn().mockResolvedValue(fresh);

    const result = await getCachedStats(redisClient, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(redisClient.get).not.toHaveBeenCalled();
    expect(redisClient.setEx).not.toHaveBeenCalled();
    expect(result).toEqual(fresh);
  });

  test('Redis null: fetchFn called directly, no crash', async () => {
    const fresh = { total_registered_users: 1, active_tokens: 1 };
    const fetchFn = jest.fn().mockResolvedValue(fresh);

    const result = await getCachedStats(null, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual(fresh);
  });

  test('redisClient.get throws → log warning, fetchFn still called, result returned', async () => {
    const fresh = { total_registered_users: 3, active_tokens: 2 };
    const redisClient = {
      isReady: true,
      get: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
      setEx: jest.fn().mockResolvedValue('OK'),
    };
    const fetchFn = jest.fn().mockResolvedValue(fresh);

    const result = await getCachedStats(redisClient, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual(fresh);
  });
});

describe('invalidateStatsCache', () => {
  test('redisClient.isReady === true → del called with [STATS_CACHE_KEY]', async () => {
    const redisClient = {
      isReady: true,
      del: jest.fn().mockResolvedValue(1),
    };

    await invalidateStatsCache(redisClient);

    expect(redisClient.del).toHaveBeenCalledWith([STATS_CACHE_KEY]);
  });

  test('redisClient.isReady === false → del not called, no throw', async () => {
    const redisClient = {
      isReady: false,
      del: jest.fn(),
    };

    await expect(invalidateStatsCache(redisClient)).resolves.toBeUndefined();
    expect(redisClient.del).not.toHaveBeenCalled();
  });

  test('del throws → error swallowed, no throw from function', async () => {
    const redisClient = {
      isReady: true,
      del: jest.fn().mockRejectedValue(new Error('del failed')),
    };

    await expect(invalidateStatsCache(redisClient)).resolves.toBeUndefined();
  });
});

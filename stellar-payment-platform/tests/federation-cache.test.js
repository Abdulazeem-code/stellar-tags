'use strict';

/**
 * Unit tests for src/federationCache.js.
 */

jest.mock('../src/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

const { logger } = require('../src/logger');
const {
  buildFederationCacheKey,
  getCachedFederationResult,
  invalidateFederationCache,
  FEDERATION_CACHE_PREFIX,
  FEDERATION_CACHE_TTL,
} = require('../src/federationCache');

describe('buildFederationCacheKey', () => {
  it('prefixes and lowercases the value', () => {
    expect(buildFederationCacheKey('id', 'GABC')).toBe('federation:id:gabc');
    expect(buildFederationCacheKey('name', 'Alice*')).toBe('federation:name:alice*');
  });
});

describe('getCachedFederationResult', () => {
  const fetchFn = jest.fn().mockResolvedValue({ address: 'G123' });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a cached JSON result when the client is ready', async () => {
    const redis = {
      isReady: true,
      get: jest.fn().mockResolvedValue(JSON.stringify({ address: 'G123' })),
      setEx: jest.fn().mockResolvedValue('OK'),
    };

    const result = await getCachedFederationResult(redis, 'key', fetchFn);

    expect(result).toEqual({ address: 'G123' });
    expect(redis.get).toHaveBeenCalledWith('key');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fetches and caches on a miss', async () => {
    const redis = {
      isReady: true,
      get: jest.fn().mockResolvedValue(null),
      setEx: jest.fn().mockResolvedValue('OK'),
    };

    const result = await getCachedFederationResult(redis, 'key', fetchFn);

    expect(result).toEqual({ address: 'G123' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(redis.setEx).toHaveBeenCalledWith('key', FEDERATION_CACHE_TTL, JSON.stringify({ address: 'G123' }));
  });

  it('falls through to fetchFn when Redis is unavailable', async () => {
    const result = await getCachedFederationResult(null, 'key', fetchFn);
    expect(result).toEqual({ address: 'G123' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not cache null results', async () => {
    const redis = { isReady: true, get: jest.fn().mockResolvedValue(null), setEx: jest.fn() };
    const nullFn = jest.fn().mockResolvedValue(null);
    const result = await getCachedFederationResult(redis, 'key', nullFn);
    expect(result).toBeNull();
    expect(redis.setEx).not.toHaveBeenCalled();
  });

  it('logs and falls through when the Redis read throws', async () => {
    const redis = {
      isReady: true,
      get: jest.fn().mockRejectedValue(new Error('connection reset')),
      setEx: jest.fn().mockResolvedValue('OK'),
    };

    const result = await getCachedFederationResult(redis, 'key', fetchFn);

    expect(result).toEqual({ address: 'G123' });
    expect(logger.error).toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('logs a write failure without rejecting the caller', async () => {
    const redis = {
      isReady: true,
      get: jest.fn().mockResolvedValue(null),
      setEx: jest.fn().mockRejectedValue(new Error('write failed')),
    };

    const result = await getCachedFederationResult(redis, 'key', fetchFn);

    expect(result).toEqual({ address: 'G123' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('invalidateFederationCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes keys for address and username when the client is ready', async () => {
    const redis = { isReady: true, del: jest.fn().mockResolvedValue(2) };
    await invalidateFederationCache(redis, 'GABC', 'Alice');
    expect(redis.del).toHaveBeenCalledWith(['federation:id:gabc', 'federation:name:alice']);
  });

  it('only deletes the provided key parts', async () => {
    const redis = { isReady: true, del: jest.fn().mockResolvedValue(1) };
    await invalidateFederationCache(redis, 'GABC');
    expect(redis.del).toHaveBeenCalledWith(['federation:id:gabc']);
  });

  it('is a no-op when the client is not ready or missing', async () => {
    await invalidateFederationCache(null, 'GABC', 'Alice');
    await invalidateFederationCache({ isReady: false, del: jest.fn() }, 'GABC', 'Alice');
  });

  it('logs and swallows deletion errors', async () => {
    const redis = {
      isReady: true,
      del: jest.fn().mockRejectedValue(new Error('gone')),
    };
    await invalidateFederationCache(redis, 'GABC', 'Alice');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('constants', () => {
  it('exposes the cache prefix', () => {
    expect(FEDERATION_CACHE_PREFIX).toBe('federation');
  });
});
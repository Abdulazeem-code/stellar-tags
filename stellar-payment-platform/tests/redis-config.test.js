'use strict';

/**
 * Unit tests for src/config/redis.js — the BullMQ-compatible Redis connection
 * factory used by webhook workers.
 */

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation((url, options) => ({ url, options }));
});

const IORedis = require('ioredis');
const { createRedisConnection, DEFAULT_REDIS_URL } = require('../src/config/redis');

describe('createRedisConnection', () => {
  beforeEach(() => {
    IORedis.mockClear();
    delete process.env.REDIS_URL;
  });

  it('connects to the default Redis URL when REDIS_URL is unset', () => {
    const client = createRedisConnection();
    expect(IORedis).toHaveBeenCalledWith(DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    expect(client.url).toBe(DEFAULT_REDIS_URL);
  });

  it('uses REDIS_URL when set', () => {
    process.env.REDIS_URL = 'redis://redis.example:6380';
    const client = createRedisConnection();
    expect(IORedis).toHaveBeenCalledWith('redis://redis.example:6380', {
      maxRetriesPerRequest: null,
    });
    expect(client.url).toBe('redis://redis.example:6380');
  });

  it('always configures blocking-command safe retries', () => {
    createRedisConnection();
    const [, options] = IORedis.mock.calls[0];
    expect(options.maxRetriesPerRequest).toBeNull();
  });
});
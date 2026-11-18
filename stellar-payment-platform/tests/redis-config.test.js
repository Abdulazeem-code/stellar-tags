'use strict';

/**
 * Unit tests for src/config/redis.js — the BullMQ-compatible Redis connection
 * factory used by webhook workers, in both single-instance and cluster mode.
 */

jest.mock('ioredis', () => {
  const Cluster = jest.fn().mockImplementation((nodes, options) => ({ kind: 'cluster', nodes, options }));
  const Redis = jest.fn().mockImplementation((url, options) => ({ kind: 'standalone', url, options }));
  Redis.Cluster = Cluster;
  return Redis;
});

const IORedis = require('ioredis');
const {
  createRedisConnection,
  isClusterMode,
  parseClusterNodes,
  DEFAULT_REDIS_URL,
} = require('../src/config/redis');

const clearRedisEnv = () => {
  delete process.env.REDIS_URL;
  delete process.env.REDIS_CLUSTER_NODES;
};

describe('createRedisConnection', () => {
  beforeEach(() => {
    IORedis.mockClear();
    IORedis.Cluster.mockClear();
    clearRedisEnv();
  });

  afterEach(clearRedisEnv);

  it('connects to the default Redis URL when REDIS_URL is unset', () => {
    const client = createRedisConnection();
    expect(IORedis).toHaveBeenCalledWith(
      DEFAULT_REDIS_URL,
      expect.objectContaining({ maxRetriesPerRequest: null }),
    );
    expect(IORedis.Cluster).not.toHaveBeenCalled();
    expect(client.url).toBe(DEFAULT_REDIS_URL);
  });

  it('uses REDIS_URL when set', () => {
    process.env.REDIS_URL = 'redis://redis.example:6380';
    const client = createRedisConnection();
    expect(IORedis).toHaveBeenCalledWith(
      'redis://redis.example:6380',
      expect.objectContaining({ maxRetriesPerRequest: null }),
    );
    expect(client.url).toBe('redis://redis.example:6380');
  });

  it('always configures blocking-command safe retries', () => {
    createRedisConnection();
    const [, options] = IORedis.mock.calls[0];
    expect(options.maxRetriesPerRequest).toBeNull();
  });

  it('keeps the offline queue enabled and reconnects with bounded backoff', () => {
    createRedisConnection();
    const [, options] = IORedis.mock.calls[0];
    expect(options.enableOfflineQueue).toBe(true);
    expect(typeof options.retryStrategy).toBe('function');
    expect(options.retryStrategy(0)).toBeLessThanOrEqual(2000);
    expect(typeof options.reconnectOnError).toBe('function');
    expect(options.reconnectOnError(new Error('READONLY You cant write against a read only replica'))).toBe(true);
    expect(options.reconnectOnError(new Error('WRONGTYPE bad command'))).toBe(false);
  });
});

describe('cluster mode', () => {
  beforeEach(() => {
    IORedis.mockClear();
    IORedis.Cluster.mockClear();
    clearRedisEnv();
  });

  afterEach(clearRedisEnv);

  it('reports cluster mode only when at least one node is advertised', () => {
    expect(isClusterMode()).toBe(false);
    process.env.REDIS_CLUSTER_NODES = 'redis-cluster-1:6379';
    expect(isClusterMode()).toBe(true);
  });

  it('parses host:port, redis:// and rediss:// entries while dropping junk and duplicates', () => {
    expect(
      parseClusterNodes(
        'a:7001, redis://b:7002 ,rediss://c, ,a:7001,http://nope:6379,host:notaport,host:99999,redis://',
      ),
    ).toEqual([
      { host: 'a', port: 7001 },
      { host: 'b', port: 7002 },
      { host: 'c', port: 6379, tls: {} },
    ]);

    expect(parseClusterNodes('')).toEqual([]);
    expect(parseClusterNodes(undefined)).toEqual([]);
    expect(parseClusterNodes('   ,  ,')).toEqual([]);
  });

  it('builds an ioredis Cluster from REDIS_CLUSTER_NODES', () => {
    process.env.REDIS_CLUSTER_NODES = 'redis-cluster-1:7001,redis-cluster-2:7002,redis-cluster-3:7003';

    const client = createRedisConnection();

    expect(IORedis).not.toHaveBeenCalled();
    expect(IORedis.Cluster).toHaveBeenCalledTimes(1);

    const [nodes, options] = IORedis.Cluster.mock.calls[0];
    expect(nodes).toEqual([
      { host: 'redis-cluster-1', port: 7001 },
      { host: 'redis-cluster-2', port: 7002 },
      { host: 'redis-cluster-3', port: 7003 },
    ]);
    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options.scaleReads).toBe('master');
    expect(typeof options.clusterRetryStrategy).toBe('function');
    expect(options.redisOptions.maxRetriesPerRequest).toBeNull();
    expect(options.redisOptions.enableOfflineQueue).toBe(true);
    expect(client.kind).toBe('cluster');
  });

  it('ignores REDIS_URL once cluster nodes are configured', () => {
    process.env.REDIS_URL = 'redis://ignored.example:6379';
    process.env.REDIS_CLUSTER_NODES = 'redis-cluster-1:7001';

    createRedisConnection();

    expect(IORedis).not.toHaveBeenCalled();
    expect(IORedis.Cluster).toHaveBeenCalledTimes(1);
  });

  it('falls back to REDIS_URL when the cluster node list has no usable node', () => {
    process.env.REDIS_URL = 'redis://fallback.example:6380';
    process.env.REDIS_CLUSTER_NODES = 'http://nope:6379,,';

    const client = createRedisConnection();

    expect(IORedis.Cluster).not.toHaveBeenCalled();
    expect(client.url).toBe('redis://fallback.example:6380');
  });
});

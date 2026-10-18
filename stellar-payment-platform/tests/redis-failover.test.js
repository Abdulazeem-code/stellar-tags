'use strict';

/**
 * Failover behaviour of the BullMQ Redis connection.
 *
 * A cluster failover surfaces transient errors — a dropped connection, a
 * CLUSTERDOWN while the slot map is refreshed, READONLY/MOVED from a replica
 * that has just been promoted. Those must be retried so an in-flight enqueue is
 * not dropped; permanent errors must surface immediately instead of burning the
 * retry budget.
 */

const { withRedisRetry, isTransientRedisError } = require('../src/config/redis');

const transientError = (code) => Object.assign(new Error(`cluster error ${code}`), { code });
const noSleep = () => Promise.resolve();

describe('isTransientRedisError', () => {
  it('treats connection and cluster-topology failures as transient', () => {
    const codes = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'CLUSTERDOWN',
      'TRYAGAIN',
      'LOADING',
      'READONLY',
      'MOVED',
      'ASK',
    ];

    for (const code of codes) {
      expect(isTransientRedisError(transientError(code))).toBe(true);
    }

    expect(isTransientRedisError(new Error('CLUSTERDOWN The cluster is down'))).toBe(true);
    expect(isTransientRedisError(new Error('Connection is closed.'))).toBe(true);
  });

  it('does not retry permanent errors', () => {
    expect(
      isTransientRedisError(new Error('WRONGTYPE Operation against a key holding the wrong kind of value')),
    ).toBe(false);
    expect(isTransientRedisError(transientError('ERR_INVALID_ARG'))).toBe(false);
    expect(isTransientRedisError(null)).toBe(false);
    expect(isTransientRedisError(undefined)).toBe(false);
  });
});

describe('withRedisRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const operation = jest.fn().mockResolvedValue('ok');

    await expect(withRedisRetry(operation, { sleep: noSleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds on a surviving node', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transientError('CLUSTERDOWN'))
      .mockRejectedValueOnce(transientError('READONLY'))
      .mockResolvedValue({ id: 'job-1' });

    await expect(withRedisRetry(operation, { attempts: 5, sleep: noSleep })).resolves.toEqual({
      id: 'job-1',
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('backs off exponentially between attempts', async () => {
    const delays = [];
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transientError('ECONNRESET'))
      .mockRejectedValueOnce(transientError('ECONNRESET'))
      .mockResolvedValue('ok');

    await withRedisRetry(operation, {
      attempts: 5,
      baseDelayMs: 10,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(delays).toEqual([10, 20]);
  });

  it('reports retries through onRetry', async () => {
    const seen = [];
    const operation = jest.fn().mockRejectedValueOnce(transientError('TRYAGAIN')).mockResolvedValue('ok');

    await withRedisRetry(operation, {
      attempts: 3,
      sleep: noSleep,
      onRetry: (error, attempt) => seen.push([error.code, attempt]),
    });

    expect(seen).toEqual([['TRYAGAIN', 1]]);
  });

  it('gives up after the configured number of attempts', async () => {
    const operation = jest.fn().mockRejectedValue(transientError('CLUSTERDOWN'));

    await expect(withRedisRetry(operation, { attempts: 3, sleep: noSleep })).rejects.toThrow('CLUSTERDOWN');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('fails fast on a permanent error without exhausting attempts', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('WRONGTYPE nope'));

    await expect(withRedisRetry(operation, { attempts: 5, sleep: noSleep })).rejects.toThrow('WRONGTYPE');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-function operation', async () => {
    await expect(withRedisRetry(null)).rejects.toThrow(TypeError);
  });
});

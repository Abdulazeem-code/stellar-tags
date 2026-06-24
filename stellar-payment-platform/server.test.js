'use strict';

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
}));

jest.mock('sqlite3', () => ({
  verbose: () => ({
    Database: jest.fn().mockImplementation((_path, cb) => {
      const db = {
        run: jest.fn(function (...args) {
          const fn = args.find((a) => typeof a === 'function');
          if (fn) fn.call({ lastID: 0, changes: 0 }, null);
        }),
        close: jest.fn((cb) => cb && cb()),
      };
      if (cb) cb(null);
      return db;
    }),
  }),
}));

jest.mock('generic-pool', () => ({
  createPool: jest.fn(() => ({
    acquire: jest.fn().mockResolvedValue({
      run: jest.fn(function (...args) {
        const fn = args.find((a) => typeof a === 'function');
        if (fn) fn.call({ lastID: 1, changes: 1 }, null);
      }),
    }),
    release: jest.fn(),
    drain: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('gracefulShutdown', () => {
  let gracefulShutdown;
  let mockServer;
  let mockPool;
  let exitSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    ({ gracefulShutdown } = require('./server'));

    mockServer = { close: jest.fn() };
    mockPool = {
      drain: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('SIGTERM — calls server.close()', () => {
    gracefulShutdown(mockServer, mockPool, 'SIGTERM');
    expect(mockServer.close).toHaveBeenCalledTimes(1);
  });

  test('SIGINT — calls server.close()', () => {
    gracefulShutdown(mockServer, mockPool, 'SIGINT');
    expect(mockServer.close).toHaveBeenCalledTimes(1);
  });

  test('drains then clears pool and exits 0 after server.close() completes', async () => {
    mockServer.close.mockImplementation((cb) => cb());

    gracefulShutdown(mockServer, mockPool, 'SIGTERM');
    // The async server.close callback chains: drain → clear → exit(0).
    // Each await is one microtask tick; flush three to reach process.exit(0).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPool.drain).toHaveBeenCalledTimes(1);
    expect(mockPool.clear).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('pool is drained after server.close() — not before', async () => {
    const callOrder = [];
    mockServer.close.mockImplementation((cb) => {
      callOrder.push('server.close');
      cb();
    });
    mockPool.drain.mockImplementation(() => {
      callOrder.push('pool.drain');
      return Promise.resolve();
    });

    gracefulShutdown(mockServer, mockPool, 'SIGTERM');
    await Promise.resolve();

    expect(callOrder).toEqual(['server.close', 'pool.drain']);
  });

  test('force-exits with code 1 if requests do not drain within 10 s', () => {
    mockServer.close.mockImplementation(() => {}); // never calls back

    gracefulShutdown(mockServer, mockPool, 'SIGTERM');
    jest.advanceTimersByTime(10_000);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockPool.drain).not.toHaveBeenCalled();
  });

  test('second signal is a no-op (double-invocation guard)', () => {
    gracefulShutdown(mockServer, mockPool, 'SIGTERM');
    gracefulShutdown(mockServer, mockPool, 'SIGTERM');

    expect(mockServer.close).toHaveBeenCalledTimes(1);
  });
});

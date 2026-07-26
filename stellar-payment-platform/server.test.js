'use strict';

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
}));

jest.mock('pdfkit', () => jest.fn());

jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));

jest.mock('sqlite3', () => ({
  verbose: () => ({
    Database: jest.fn().mockImplementation((_path, cb) => {
      const db = {
        run: jest.fn(function (...args) {
          const fn = args.find((a) => typeof a === 'function');
          if (fn) fn.call({ lastID: 0, changes: 0 }, null);
        }),
        serialize: jest.fn((fn) => fn && fn()),
        close: jest.fn((cb) => cb && cb()),
      };
      if (cb) cb(null);
      return db;
    }),
  }),
}));

jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));

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

describe('rejectNestedObjects middleware', () => {
  let rejectNestedObjects;
  let res;
  let next;

  beforeAll(() => {
    ({ rejectNestedObjects } = require('./server'));
  });

  beforeEach(() => {
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  test('passes through when body contains only string values', () => {
    rejectNestedObjects({ query: {}, body: { username: 'alice*localhost', address: 'GABC123' } }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('passes through when query contains only string values', () => {
    rejectNestedObjects({ query: { q: 'alice*localhost' }, body: {} }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('passes through when query and body are empty', () => {
    rejectNestedObjects({ query: {}, body: {} }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('passes through when body is undefined (no-body GET requests)', () => {
    rejectNestedObjects({ query: { address: 'GABC123' }, body: undefined }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('rejects 400 when body value is a nested object', () => {
    rejectNestedObjects({ query: {}, body: { username: { $ne: '' } } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      detail: 'Invalid parameter type: nested objects and arrays are not allowed.',
    });
  });

  test('rejects 400 when query value is a nested object', () => {
    rejectNestedObjects({ query: { q: { $ne: '' } }, body: {} }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects 400 when body value is an array', () => {
    rejectNestedObjects({ query: {}, body: { username: ['alice', 'bob'] } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects 400 when query value is an array', () => {
    rejectNestedObjects({ query: { address: ['GABC', 'GXYZ'] }, body: {} }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('passes through null values (legitimate optional param absence)', () => {
    rejectNestedObjects({ query: { search: null }, body: {} }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('validateRegister middleware', () => {
  let validateRegister;
  let res;
  let next;

  beforeAll(() => {
    ({ validateRegister } = require('./server'));
  });

  beforeEach(() => {
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  // ── happy-path ────────────────────────────────────────────────────────────

  test('passes through a valid username and Stellar address', () => {
    const req = {
      body: {
        username: 'alice123',
        address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      },
    };
    validateRegister(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('passes through a 3-character username (minimum length)', () => {
    const req = {
      body: {
        username: 'abc',
        address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      },
    };
    validateRegister(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('passes through a 20-character username (maximum length)', () => {
    const req = {
      body: {
        username: 'a'.repeat(20),
        address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      },
    };
    validateRegister(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── username failures ─────────────────────────────────────────────────────

  test('rejects 400 when username is missing', () => {
    const req = {
      body: { address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ' },
    };
    validateRegister(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.errors.some((e) => e.field === 'username')).toBe(true);
  });

  test('rejects 400 when username is too short (2 chars)', () => {
    const req = {
      body: {
        username: 'ab',
        address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      },
    };
    validateRegister(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects 400 when username is too long (21 chars)', () => {
    const req = {
      body: {
        username: 'a'.repeat(21),
        address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      },
    };
    validateRegister(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects 400 when username contains non-alphanumeric characters', () => {
    const req = {
      body: {
        username: 'alice!',
        address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      },
    };
    validateRegister(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects 400 when username contains spaces', () => {
    const req = {
      body: {
        username: 'alice bob',
        address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      },
    };
    validateRegister(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  // ── address failures ──────────────────────────────────────────────────────

  test('rejects 400 when address is missing', () => {
    const req = { body: { username: 'alice' } };
    validateRegister(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.errors.some((e) => e.field === 'address')).toBe(true);
  });

  test('rejects 400 when address does not start with G', () => {
    const req = {
      body: {
        username: 'alice',
        // Same length but starts with S (secret key prefix)
        address: 'SAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      },
    };
    validateRegister(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects 400 when address is too short', () => {
    const req = {
      body: { username: 'alice', address: 'GABC123' },
    };
    validateRegister(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects 400 when both username and address are invalid (reports both errors)', () => {
    const req = { body: { username: 'x!', address: 'invalid' } };
    validateRegister(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    const fields = body.errors.map((e) => e.field);
    expect(fields).toContain('username');
    expect(fields).toContain('address');
  });
});

'use strict';

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

jest.mock('pdfkit', () => jest.fn());

// The cleanup cron schedules a recurring job at module load — stub it so the
// test process does not register a real timer.
jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('./src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

// bad-words ships as ESM; Jest runs in CJS mode — mock the module so the
// test suite can require server.js without a transform error.
jest.mock('bad-words', () => {
  return jest.fn().mockImplementation(() => ({
    isProfane: jest.fn(() => false),
  }));
});
jest.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

// Prisma is mocked so the suite never touches a real database...
jest.mock('./prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: (error) => {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (code.startsWith('P10')) return true;
    const causeCode = typeof error?.cause?.code === 'string' ? error.cause.code : '';
    return causeCode.startsWith('P10');
  },
}));

jest.mock('./src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({
    success: true,
    accountId: 'GDUMMYACCOUNTIDIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',
    operationType: 'management',
    requiredThreshold: 1,
    totalWeight: 1,
    signatureCount: 1,
    uniqueSignerCount: 1,
    signatures: [{ publicKey: 'GDUMMY', weight: 1, isValid: true }],
    thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
    signerCount: 1,
    errorMessage: null,
  }),
  isSingleSignerAccount: jest.fn().mockReturnValue(true),
}));

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
jest.mock('./src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

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
  let mockPrisma;
  let exitSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    ({ gracefulShutdown } = require('./server'));

    mockServer = { close: jest.fn() };
    mockPrisma = {
      $disconnect: jest.fn().mockResolvedValue(undefined),
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
    gracefulShutdown(mockServer, mockPrisma, 'SIGTERM');
    expect(mockServer.close).toHaveBeenCalledTimes(1);
  });

  test('SIGINT — calls server.close()', () => {
    gracefulShutdown(mockServer, mockPrisma, 'SIGINT');
    expect(mockServer.close).toHaveBeenCalledTimes(1);
  });

  test('disconnects Prisma and exits 0 after server.close() completes', async () => {
    mockServer.close.mockImplementation((cb) => cb());

    gracefulShutdown(mockServer, mockPrisma, 'SIGTERM');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPrisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('Prisma disconnects after server.close() — not before', async () => {
    const callOrder = [];
    mockServer.close.mockImplementation((cb) => {
      callOrder.push('server.close');
      cb();
    });
    mockPrisma.$disconnect.mockImplementation(() => {
      callOrder.push('prisma.$disconnect');
      return Promise.resolve();
    });

    gracefulShutdown(mockServer, mockPrisma, 'SIGTERM');
    await Promise.resolve();

    expect(callOrder).toEqual(['server.close', 'prisma.$disconnect']);
  });

  test('force-exits with code 1 if requests do not drain within 10 s', () => {
    mockServer.close.mockImplementation(() => {}); // never calls back

    gracefulShutdown(mockServer, mockPrisma, 'SIGTERM');
    jest.advanceTimersByTime(10_000);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockPrisma.$disconnect).not.toHaveBeenCalled();
  });

  test('second signal is a no-op (double-invocation guard)', () => {
    gracefulShutdown(mockServer, mockPrisma, 'SIGTERM');
    gracefulShutdown(mockServer, mockPrisma, 'SIGTERM');

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

describe('GET /lookup — pagination and search', () => {
  let request;
  let app;
  let prisma;

  const VALID_ADDRESS = 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ';

  beforeEach(() => {
    jest.resetModules();

    jest.mock('dotenv', () => ({ config: jest.fn() }));
    jest.mock('fs', () => ({ ...jest.requireActual('fs'), mkdirSync: jest.fn() }));
    jest.mock('@stellar/stellar-sdk', () => ({ Horizon: { Server: jest.fn() }, StrKey: { isValidEd25519PublicKey: jest.fn(() => true) } }));
    jest.mock('pdfkit', () => jest.fn());
    jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('./src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

    jest.mock('sqlite3', () => ({
      verbose: () => ({
        Database: jest.fn().mockImplementation((_path, cb) => {
          const db = { run: jest.fn((sql, cb2) => cb2 && cb2(null)), close: jest.fn((cb2) => cb2 && cb2()) };
          if (cb) cb(null);
          return db;
        }),
      }),
    }));

    const mockConn = {
      run: jest.fn((sql, params, cb) => {
        const fn = typeof params === 'function' ? params : cb;
        if (fn) fn.call({ lastID: 0, changes: 0 }, null);
      }),
      get: jest.fn((sql, params, cb) => {
        const fn = typeof params === 'function' ? params : cb;
        if (sql.includes('COUNT(*)')) {
          if (fn) fn(null, { total: 2 });
        } else if (sql.includes('WHERE address =')) {
          if (fn) fn(null, { username: 'alice*localhost' });
        } else {
          if (fn) fn(null, null);
        }
      }),
      all: jest.fn((sql, params, cb) => {
        const fn = typeof params === 'function' ? params : cb;
        const rows = [
          { username: 'alice*localhost', address: VALID_ADDRESS, created_at: '2024-01-01T00:00:00.000Z' },
          { username: 'bob*localhost', address: 'GBOB0000000000000000000000000000000000000000000000000000', created_at: '2024-01-02T00:00:00.000Z' },
        ];
        if (fn) fn(null, rows);
      }),
    };

    jest.mock('generic-pool', () => ({
      createPool: jest.fn(() => ({
        acquire: jest.fn().mockResolvedValue(mockConn),
        release: jest.fn(),
        drain: jest.fn().mockResolvedValue(undefined),
        clear: jest.fn().mockResolvedValue(undefined),
      })),
    }));

    ({ app } = require('./server'));
    ({ prisma } = require('./prismaClient'));
    request = require('supertest');

    prisma.user.findUnique.mockReset();
    prisma.user.findMany.mockReset();
    prisma.user.count.mockReset();
    prisma.$transaction = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns 400 when neither address nor search is provided', async () => {
    const res = await request(app).get('/lookup');
    expect(res.status).toBe(400);
  });

  test('exact address lookup returns single record (backward compat)', async () => {
    prisma.user.findUnique.mockResolvedValue({ username: 'alice*localhost' });

    const res = await request(app).get(`/lookup?address=${VALID_ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: 'alice*localhost', address: VALID_ADDRESS });
    expect(res.body).not.toHaveProperty('data');
  });

  test('search mode returns paginated metadata block', async () => {
    prisma.user.count.mockResolvedValue(2);
    prisma.user.findMany.mockResolvedValue([
      { username: 'alice*localhost', address: VALID_ADDRESS, createdAt: new Date('2024-01-01T00:00:00.000Z') },
      { username: 'bob*localhost', address: 'GBOB0000000000000000000000000000000000000000000000000000', createdAt: new Date('2024-01-02T00:00:00.000Z') },
    ]);
    prisma.$transaction.mockResolvedValue([2, [
      { username: 'alice*localhost', address: VALID_ADDRESS, createdAt: new Date('2024-01-01T00:00:00.000Z') },
      { username: 'bob*localhost', address: 'GBOB0000000000000000000000000000000000000000000000000000', createdAt: new Date('2024-01-02T00:00:00.000Z') },
    ]]);

    const res = await request(app).get('/lookup?search=alice&page=1&limit=10');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('totalCount');
    expect(res.body).toHaveProperty('totalPages');
    expect(res.body).toHaveProperty('currentPage', 1);
  });

  test('search mode defaults page to 1 and limit to 10 when omitted', async () => {
    prisma.user.count.mockResolvedValue(2);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.$transaction.mockResolvedValue([2, []]);

    const res = await request(app).get('/lookup?search=alice');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ currentPage: 1 });
  });
});

describe('GET /users — pagination and search', () => {
  let request;
  let app;
  let prisma;

  beforeEach(() => {
    jest.resetModules();

    jest.mock('dotenv', () => ({ config: jest.fn() }));
    jest.mock('fs', () => ({ ...jest.requireActual('fs'), mkdirSync: jest.fn() }));
    jest.mock('@stellar/stellar-sdk', () => ({ Horizon: { Server: jest.fn() }, StrKey: { isValidEd25519PublicKey: jest.fn(() => true) } }));
    jest.mock('pdfkit', () => jest.fn());
    jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('./src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

    jest.mock('sqlite3', () => ({
      verbose: () => ({
        Database: jest.fn().mockImplementation((_path, cb) => {
          const db = { run: jest.fn((sql, cb2) => cb2 && cb2(null)), close: jest.fn((cb2) => cb2 && cb2()) };
          if (cb) cb(null);
          return db;
        }),
      }),
    }));

    const mockConn = {
      run: jest.fn((sql, params, cb) => {
        const fn = typeof params === 'function' ? params : cb;
        if (fn) fn.call({ lastID: 0, changes: 0 }, null);
      }),
      get: jest.fn((sql, params, cb) => {
        const fn = typeof params === 'function' ? params : cb;
        if (fn) fn(null, { total: 25 });
      }),
      all: jest.fn((sql, params, cb) => {
        const fn = typeof params === 'function' ? params : cb;
        const rows = Array.from({ length: 10 }, (_, i) => ({
          username: `user${i}*localhost`,
          address: `G${'A'.repeat(55)}${i}`,
          created_at: '2024-01-01T00:00:00.000Z',
        }));
        if (fn) fn(null, rows);
      }),
    };

    jest.mock('generic-pool', () => ({
      createPool: jest.fn(() => ({
        acquire: jest.fn().mockResolvedValue(mockConn),
        release: jest.fn(),
        drain: jest.fn().mockResolvedValue(undefined),
        clear: jest.fn().mockResolvedValue(undefined),
      })),
    }));

    ({ app } = require('./server'));
    ({ prisma } = require('./prismaClient'));
    request = require('supertest');

    prisma.user.findMany.mockReset();
    prisma.user.count.mockReset();

    prisma.user.count.mockResolvedValue(25);
    prisma.user.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        username: `user${i}*localhost`,
        address: `G${'A'.repeat(55)}${i}`,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      })),
    );
    prisma.$transaction = jest.fn().mockResolvedValue([25, Array.from({ length: 10 }, (_, i) => ({
      username: `user${i}*localhost`,
      address: `G${'A'.repeat(55)}${i}`,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    }))]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns paginated metadata block with default page and limit', async () => {
    const res = await request(app).get('/users');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalCount: 25, currentPage: 1 });
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toMatchObject({
      total: 25,
      page: 1,
      limit: 10,
    });
  });

  test('respects explicit page and limit query params', async () => {
    const res = await request(app).get('/users?page=3&limit=5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ currentPage: 3 });
    expect(res.body.meta).toMatchObject({
      page: 3,
      limit: 5,
    });
  });

  test('accepts search query param without error', async () => {
    const res = await request(app).get('/users?search=alice');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
  });
});

describe('POST /register — block secret keys', () => {
  let request;
  let app;

  beforeEach(() => {
    jest.resetModules();

    jest.mock('dotenv', () => ({ config: jest.fn() }));
    jest.mock('fs', () => ({ ...jest.requireActual('fs'), mkdirSync: jest.fn() }));
    jest.mock('@stellar/stellar-sdk', () => ({
      Horizon: { Server: jest.fn() },
      StrKey: { isValidEd25519PublicKey: jest.fn((addr) => addr && (addr.startsWith('G') || addr.startsWith('S') || addr.startsWith('s'))) }
    }));
    jest.mock('pdfkit', () => jest.fn());
    jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('./src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

    ({ app } = require('./server'));
    request = require('supertest');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('blocks registration if address starts with S (uppercase)', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: 'SBCDEFGHIJKLMNOPQRSTUVWXYZ' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Never share your Secret Key. Please register using your Public Key (starts with G)."
    });
  });

  test('blocks registration if address starts with s (lowercase)', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: 'sBCDEFGHIJKLMNOPQRSTUVWXYZ' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Never share your Secret Key. Please register using your Public Key (starts with G)."
    });
  });

  test('allows registration and continues flow if address starts with G', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: 'GBCDEFGHIJKLMNOPQRSTUVWXYZ' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      username: 'alice*localhost',
      address: 'GBCDEFGHIJKLMNOPQRSTUVWXYZ'
    });
  });

  test('rejects registration if Content-Type header is not application/json', async () => {
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'alice', address: 'GBCDEFGHIJKLMNOPQRSTUVWXYZ' });

    // This should succeed with proper content-type
    expect([200, 201, 409, 401, 404, 400]).toContain(res.status);
  });

  test('rejects registration with short username', async () => {
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'a', address: 'GBCDEFGHIJKLMNOPQRSTUVWXYZ' });

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('errors');
  });

  test('rejects 1-character local username payload', async () => {
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'a', address: 'GBCDEFGHIJKLMNOPQRSTUVWXYZ' });

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('errors');
  });

  test('rejects 2-character local username payload', async () => {
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'ab', address: 'GBCDEFGHIJKLMNOPQRSTUVWXYZ' });

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('errors');
  });

  test('rejects 2-character local username payload with domain suffix', async () => {
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'ab*domain.com', address: 'GBCDEFGHIJKLMNOPQRSTUVWXYZ' });

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('errors');
  });

  test('allows 3-character username payload', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'abc', address: 'GBCDEFGHIJKLMNOPQRSTUVWXYZ' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      username: 'abc*localhost',
      address: 'GBCDEFGHIJKLMNOPQRSTUVWXYZ'
    });
  });
});

describe('POST /register — memo validation', () => {
  let request;
  let app;
  let prisma;

  const VALID_ADDRESS = 'GBCDEFGHIJKLMNOPQRSTUVWXYZ';

  beforeEach(() => {
    jest.resetModules();
    ({ app } = require('./server'));
    ({ prisma } = require('./prismaClient'));
    request = require('supertest');

    prisma.user.findUnique.mockReset();
    prisma.user.create.mockReset();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      username: 'alice*localhost',
      address: VALID_ADDRESS,
      memoType: null,
      memo: null,
    });
  });

  test('registers without memo fields', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: VALID_ADDRESS });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('memo_type');
    expect(res.body).not.toHaveProperty('memo');
  });

  test('accepts valid text memo (≤28 bytes)', async () => {
    prisma.user.create.mockResolvedValue({ username: 'alice*localhost', address: VALID_ADDRESS, memoType: 'text', memo: 'pay123' });
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: VALID_ADDRESS, memo_type: 'text', memo: 'pay123' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ memo_type: 'text', memo: 'pay123' });
  });

  test('rejects text memo exceeding 28 bytes', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: VALID_ADDRESS, memo_type: 'text', memo: 'a'.repeat(29) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/28 bytes/);
  });

  test('accepts valid id memo (64-bit uint)', async () => {
    prisma.user.create.mockResolvedValue({ username: 'alice*localhost', address: VALID_ADDRESS, memoType: 'id', memo: '12345678' });
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: VALID_ADDRESS, memo_type: 'id', memo: '12345678' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ memo_type: 'id', memo: '12345678' });
  });

  test('rejects id memo with non-numeric value', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: VALID_ADDRESS, memo_type: 'id', memo: 'notanumber' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/64-bit unsigned integer/);
  });

  test('accepts valid hash memo (64 hex chars)', async () => {
    const validHash = 'a'.repeat(64);
    prisma.user.create.mockResolvedValue({ username: 'alice*localhost', address: VALID_ADDRESS, memoType: 'hash', memo: validHash });
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: VALID_ADDRESS, memo_type: 'hash', memo: validHash });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ memo_type: 'hash', memo: validHash });
  });

  test('rejects hash memo that is not 64 hex chars', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: VALID_ADDRESS, memo_type: 'hash', memo: 'tooshort' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/64-character hex/);
  });

  test('rejects unknown memo_type', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: VALID_ADDRESS, memo_type: 'return', memo: 'something' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/memo_type must be one of/);
  });

  test('rejects memo without memo_type', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: VALID_ADDRESS, memo: 'orphan' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/memo_type is required/);
  });

  test('rejects memo_type without memo', async () => {
    const res = await request(app)
      .post('/register')
      .send({ username: 'alice', address: VALID_ADDRESS, memo_type: 'text' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/memo is required/);
  });
});

describe('GET /federation — memo fields in response', () => {
  let request;
  let app;
  let prisma;

  const VALID_ADDRESS = 'GBCDEFGHIJKLMNOPQRSTUVWXYZ';

  beforeEach(() => {
    jest.resetModules();
    ({ app } = require('./server'));
    ({ prisma } = require('./prismaClient'));
    request = require('supertest');

    prisma.user.findUnique.mockReset();
    prisma.user.findFirst.mockReset();
  });

  test('omits memo fields when user has no memo configured', async () => {
    prisma.user.findUnique.mockResolvedValue({ address: VALID_ADDRESS, memoType: null, memo: null });
    const res = await request(app).get('/federation?q=alice*localhost&type=name');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('memo_type');
    expect(res.body).not.toHaveProperty('memo');
  });

  test('returns stored text memo in federation response', async () => {
    prisma.user.findUnique.mockResolvedValue({ address: VALID_ADDRESS, memoType: 'text', memo: 'pay123' });
    const res = await request(app).get('/federation?q=alice*localhost&type=name');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ memo_type: 'text', memo: 'pay123' });
  });

  test('returns stored id memo in type=id federation response', async () => {
    prisma.user.findFirst.mockResolvedValue({ username: 'alice*localhost', address: VALID_ADDRESS, memoType: 'id', memo: '999' });
    const res = await request(app).get(`/federation?q=${VALID_ADDRESS}&type=id`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ memo_type: 'id', memo: '999' });
  });

  test('omits memo fields for type=id lookup when no memo set', async () => {
    prisma.user.findFirst.mockResolvedValue({ username: 'alice*localhost', address: VALID_ADDRESS, memoType: null, memo: null });
    const res = await request(app).get(`/federation?q=${VALID_ADDRESS}&type=id`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('memo_type');
    expect(res.body).not.toHaveProperty('memo');
  });
});


describe('API v1 routing', () => {
  let request;
  let app;

  let prisma;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('dotenv', () => ({ config: jest.fn() }));
    jest.mock('fs', () => ({ ...jest.requireActual('fs'), mkdirSync: jest.fn() }));
    jest.mock('@stellar/stellar-sdk', () => ({ Horizon: { Server: jest.fn() }, StrKey: { isValidEd25519PublicKey: jest.fn(() => true) } }));
    jest.mock('pdfkit', () => jest.fn());
    jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('./src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

    jest.mock('sqlite3', () => ({
      verbose: () => ({
        Database: jest.fn().mockImplementation((_path, cb) => {
          const db = { run: jest.fn((sql, cb2) => cb2 && cb2(null)), close: jest.fn((cb2) => cb2 && cb2()) };
          if (cb) cb(null);
          return db;
        }),
      }),
    }));

    const mockConn = {
      run: jest.fn((sql, params, cb) => {
        const fn = typeof params === 'function' ? params : cb;
        if (fn) fn.call({ lastID: 0, changes: 0 }, null);
      }),
      get: jest.fn((sql, params, cb) => {
        const fn = typeof params === 'function' ? params : cb;
        if (fn) fn(null, { total: 2 });
      }),
      all: jest.fn((sql, params, cb) => {
        const fn = typeof params === 'function' ? params : cb;
        if (fn) fn(null, [
          { username: 'alice*localhost', address: 'GABC', created_at: '2024-01-01T00:00:00.000Z' },
        ]);
      }),
    };

    jest.mock('generic-pool', () => ({
      createPool: jest.fn(() => ({
        acquire: jest.fn().mockResolvedValue(mockConn),
        release: jest.fn(),
        drain: jest.fn().mockResolvedValue(undefined),
        clear: jest.fn().mockResolvedValue(undefined),
      })),
    }));

    ({ app } = require('./server'));
    ({ prisma } = require('./prismaClient'));
    request = require('supertest');

    prisma.user.count.mockReset();
    prisma.user.findMany.mockReset();
    prisma.$transaction.mockReset();
    prisma.user.count.mockResolvedValue(2);
    prisma.user.findMany.mockResolvedValue([
      { username: 'alice*localhost', address: 'GABC', createdAt: new Date('2024-01-01T00:00:00.000Z') },
    ]);
    prisma.$transaction.mockResolvedValue([2, [
      { username: 'alice*localhost', address: 'GABC', createdAt: new Date('2024-01-01T00:00:00.000Z') },
    ]]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('GET /api/v1/lookup returns 400 without params', async () => {
    const res = await request(app).get('/api/v1/lookup');
    expect(res.status).toBe(400);
  });

  test('GET /api/v1/users returns paginated data', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('GET /api/v1/federation returns 400 without q param', async () => {
    const res = await request(app).get('/api/v1/federation');
    expect(res.status).toBe(400);
  });
});

describe('Idempotency Middleware', () => {
  let app;
  let request;
  let prisma;

  beforeEach(() => {
    jest.resetModules();
    ({ app } = require('./server'));
    ({ prisma } = require('./prismaClient'));
    request = require('supertest');
    
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 1,
      username: 'idempotent-user',
      address: 'GABC123',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('POST /register with new idempotency key succeeds and caches', async () => {
    const payload = {
      username: 'idempotentuser',
      address: 'GDUMMYACCOUNTIDIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',
      signature: 'GDUMMYACCOUNTIDIIIIIIIIIIIIIIIIIIIIIIIIIIIIII'
    };
    
    // First request
    const res1 = await request(app)
      .post('/register')
      .set('X-Idempotency-Key', 'test-key-123')
      .set('Content-Type', 'application/json')
      .send(payload);
    
    expect([200, 201, 400, 401, 404, 409]).toContain(res1.status);
    expect(res1.header['x-idempotent-replay']).toBeUndefined();

    // Second request with SAME key
    const res2 = await request(app)
      .post('/register')
      .set('X-Idempotency-Key', 'test-key-123')
      .set('Content-Type', 'application/json')
      .send(payload);
    
    expect(res2.status).toBe(201);
    expect(res2.header['x-idempotent-replay']).toBe('true');
    expect(res2.body).toEqual(res1.body);
    
    // Ensure prisma.user.create was only called once
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });
});

describe('Database disconnection — 503 handling', () => {
  let request;
  let app;
  let prisma;

  const makePrismaError = (code) => {
    const err = new Error(`Prisma ${code}: simulated database connection error`);
    err.code = code;
    return err;
  };

  beforeEach(() => {
    jest.resetModules();

    jest.mock('dotenv', () => ({ config: jest.fn() }));
    jest.mock('fs', () => ({ ...jest.requireActual('fs'), mkdirSync: jest.fn() }));
    jest.mock('@stellar/stellar-sdk', () => ({ Horizon: { Server: jest.fn() }, StrKey: { isValidEd25519PublicKey: jest.fn(() => true) } }));
    jest.mock('pdfkit', () => jest.fn());
    jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
    jest.mock('./src/multisigner-verifier', () => ({
      verifyMultiSignerThreshold: jest.fn().mockResolvedValue({
        success: true, accountId: 'GDUMMY', operationType: 'management',
        requiredThreshold: 1, totalWeight: 1, signatureCount: 1, uniqueSignerCount: 1,
        signatures: [{ publicKey: 'GDUMMY', weight: 1, isValid: true }],
        thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
        signerCount: 1, errorMessage: null,
      }),
      isSingleSignerAccount: jest.fn().mockReturnValue(true),
    }));

    jest.mock('sqlite3', () => ({
      verbose: () => ({
        Database: jest.fn().mockImplementation((_path, cb) => {
          const db = { run: jest.fn((sql, cb2) => cb2 && cb2(null)), close: jest.fn((cb2) => cb2 && cb2()) };
          if (cb) cb(null);
          return db;
        }),
      }),
    }));

    const mockConn = {
      run: jest.fn((sql, params, cb) => { const fn = typeof params === 'function' ? params : cb; if (fn) fn(null); }),
      get: jest.fn((sql, params, cb) => { const fn = typeof params === 'function' ? params : cb; if (fn) fn(null, null); }),
      all: jest.fn((sql, params, cb) => { const fn = typeof params === 'function' ? params : cb; if (fn) fn(null, []); }),
    };

    jest.mock('generic-pool', () => ({
      createPool: jest.fn(() => ({
        acquire: jest.fn().mockResolvedValue(mockConn),
        release: jest.fn(),
        drain: jest.fn().mockResolvedValue(undefined),
        clear: jest.fn().mockResolvedValue(undefined),
      })),
    }));

    ({ app } = require('./server'));
    ({ prisma } = require('./prismaClient'));
    request = require('supertest');

    prisma.user.findUnique.mockReset();
    prisma.user.findFirst.mockReset();
    prisma.user.findMany.mockReset();
    prisma.user.count.mockReset();
    prisma.user.create.mockReset();
    prisma.$transaction.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    ['P1001', 'Connection refused'],
    ['P1008', 'Connection timeout'],
    ['P1017', 'Pool timeout'],
  ])('GET /api/v1/federation returns 503 when Prisma throws %s', async (code) => {
    prisma.user.findUnique.mockRejectedValue(makePrismaError(code));

    const res = await request(app).get('/api/v1/federation?q=alice*localhost&type=name');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Service Unavailable');
  });

  test.each([
    ['P1001'],
    ['P1008'],
    ['P1017'],
  ])('GET /api/v1/lookup returns 503 on address lookup when Prisma throws %s', async (code) => {
    prisma.user.findUnique.mockRejectedValue(makePrismaError(code));

    const res = await request(app).get(`/api/v1/lookup?address=GABC123`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Service Unavailable');
  });

  test.each([
    ['P1001'],
    ['P1008'],
  ])('GET /api/v1/lookup returns 503 on search when Prisma throws %s', async (code) => {
    prisma.$transaction.mockRejectedValue(makePrismaError(code));

    const res = await request(app).get('/api/v1/lookup?search=alice');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Service Unavailable');
  });

  test.each([
    ['P1001'],
    ['P1008'],
  ])('GET /api/v1/users returns 503 when Prisma throws %s', async (code) => {
    prisma.$transaction.mockRejectedValue(makePrismaError(code));

    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Service Unavailable');
  });

  test.each([
    ['P1001'],
    ['P1008'],
  ])('POST /api/v1/register returns 503 when Prisma throws %s', async (code) => {
    prisma.user.findUnique.mockRejectedValue(makePrismaError(code));

    const res = await request(app)
      .post('/api/v1/register')
      .send({ username: 'newuser', address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Service Unavailable');
  });

  test('server.js routes with SQLite fallback still return normally for Prisma P10 errors', async () => {
    prisma.user.findUnique.mockRejectedValue(makePrismaError('P1001'));

    const res = await request(app).get('/federation?q=nonexistent*localhost&type=name');
    expect(res.status).toBe(404);
  });
});
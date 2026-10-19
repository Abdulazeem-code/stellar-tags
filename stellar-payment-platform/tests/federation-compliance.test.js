'use strict';

// Contract tests for GET /federation against the SEP-0002 federation protocol.
// Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0002.md
//
// SEP-0002 in brief:
//   - Request is an HTTP GET with `q` (the string to look up) and `type`
//     ("name" | "id" | "txid" | "forward").
//   - A found record returns HTTP 200 with a JSON body containing
//     `stellar_address` and `account_id`, plus the optional pair `memo_type`
//     (one of "text", "id", "hash") and `memo`.
//   - A record that is not found returns HTTP 404.
//   - Other failures return a JSON body carrying an error description.
//
// This platform supports `type=name` and `type=id`; `txid` and `forward` are
// not implemented and are rejected as invalid input. Error bodies use the
// platform envelope `{ success: false, error: { code, message } }` rather than
// SEP-0002's bare `{ error: "..." }`, so the error message lives at
// `body.error.message`.

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

jest.mock('pdfkit', () => jest.fn());

// The cron modules register recurring timers at import time; stub them so the
// test process does not keep real timers alive.
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

jest.mock('bad-words', () =>
  jest.fn().mockImplementation(() => ({ isProfane: jest.fn(() => false) })),
);

jest.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: (error) => {
    const code = typeof error?.code === 'string' ? error.code : '';
    return code.startsWith('P10');
  },
}));

jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(),
  isSingleSignerAccount: jest.fn().mockReturnValue(true),
}));

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  })),
}));

const request = require('supertest');

// A well-formed Stellar public key, used for type=id lookups.
const ACCOUNT_ID = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';

describe('GET /federation — SEP-0002 compliance', () => {
  let app;
  let prisma;

  beforeEach(() => {
    jest.resetModules();
    ({ app } = require('../server'));
    ({ prisma } = require('../prismaClient'));
    prisma.user.findFirst.mockReset();
  });

  describe('type=name lookups', () => {
    test('returns 200 with stellar_address and account_id for a known name', async () => {
      prisma.user.findFirst.mockResolvedValue({
        address: ACCOUNT_ID,
        memoType: null,
        memo: null,
        flaggedAt: null,
      });

      const res = await request(app).get('/federation').query({
        q: 'alice*localhost',
        type: 'name',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        stellar_address: expect.any(String),
        account_id: ACCOUNT_ID,
      });
    });

    test('defaults to a name lookup when type is omitted', async () => {
      prisma.user.findFirst.mockResolvedValue({
        address: ACCOUNT_ID,
        memoType: null,
        memo: null,
        flaggedAt: null,
      });

      const res = await request(app).get('/federation').query({ q: 'bob*localhost' });

      expect(res.status).toBe(200);
      expect(res.body.account_id).toBe(ACCOUNT_ID);
      expect(prisma.user.findFirst).toHaveBeenCalled();
    });

    test('resolves a bare username by appending the federation domain', async () => {
      prisma.user.findFirst.mockResolvedValue({
        address: ACCOUNT_ID,
        memoType: null,
        memo: null,
        flaggedAt: null,
      });

      const res = await request(app).get('/federation').query({ q: 'carol', type: 'name' });

      expect(res.status).toBe(200);
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ username: 'carol*localhost' }) }),
      );
    });

    test('falls back to the built-in registry for a seeded name', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/federation').query({ q: 'client*localhost', type: 'name' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        stellar_address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
        account_id: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      });
    });
  });

  describe('type=id lookups', () => {
    test('returns 200 with a name-shaped stellar_address and the queried account_id', async () => {
      prisma.user.findFirst.mockResolvedValue({
        username: 'alice',
        address: ACCOUNT_ID,
        memoType: null,
        memo: null,
        flaggedAt: null,
      });

      const res = await request(app).get('/federation').query({ q: ACCOUNT_ID, type: 'id' });

      expect(res.status).toBe(200);
      expect(res.body.account_id).toBe(ACCOUNT_ID);
      expect(res.body.stellar_address).toMatch(/^alice\*/);
    });

    test('matches the account id case-insensitively', async () => {
      prisma.user.findFirst.mockResolvedValue({
        username: 'alice',
        address: ACCOUNT_ID,
        memoType: null,
        memo: null,
        flaggedAt: null,
      });

      const res = await request(app)
        .get('/federation')
        .query({ q: ACCOUNT_ID.toLowerCase(), type: 'id' });

      expect(res.status).toBe(200);
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            address: { equals: ACCOUNT_ID.toLowerCase(), mode: 'insensitive' },
          }),
        }),
      );
    });
  });

  describe('memo_type and memo fields', () => {
    test.each([
      ['text', 'invoice-4711'],
      ['id', '1234567890'],
      ['hash', 'a'.repeat(64)],
    ])('passes through a %s memo on a name lookup', async (memoType, memo) => {
      prisma.user.findFirst.mockResolvedValue({
        address: ACCOUNT_ID,
        memoType,
        memo,
        flaggedAt: null,
      });

      const res = await request(app)
        .get('/federation')
        .query({ q: `memo-${memoType}*localhost`, type: 'name' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ memo_type: memoType, memo });
      expect(['text', 'id', 'hash']).toContain(res.body.memo_type);
    });

    test('returns memo_type and memo on an id lookup', async () => {
      prisma.user.findFirst.mockResolvedValue({
        username: 'dave',
        address: ACCOUNT_ID,
        memoType: 'id',
        memo: '999',
        flaggedAt: null,
      });

      const res = await request(app).get('/federation').query({ q: ACCOUNT_ID, type: 'id' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ memo_type: 'id', memo: '999' });
    });

    test('omits both memo fields entirely when no memo is configured', async () => {
      prisma.user.findFirst.mockResolvedValue({
        address: ACCOUNT_ID,
        memoType: null,
        memo: null,
        flaggedAt: null,
      });

      const res = await request(app)
        .get('/federation')
        .query({ q: 'no-memo*localhost', type: 'name' });

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('memo_type');
      expect(res.body).not.toHaveProperty('memo');
    });
  });

  describe('error responses', () => {
    test('returns 404 when a name is not found', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .get('/federation')
        .query({ q: 'ghost*localhost', type: 'name' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.error.message).toBe('string');
      expect(res.body.error.message.length).toBeGreaterThan(0);
    });

    test('returns 404 when an account id is not found', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/federation').query({ q: ACCOUNT_ID, type: 'id' });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
    });

    test('returns 400 when the q parameter is missing', async () => {
      const res = await request(app).get('/federation').query({ type: 'name' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message.length).toBeGreaterThan(0);
    });

    test('returns 400 when q is blank', async () => {
      const res = await request(app).get('/federation').query({ q: '   ', type: 'name' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test.each(['txid', 'forward', 'bogus'])(
      'rejects the unsupported lookup type %s with 400',
      async (type) => {
        const res = await request(app).get('/federation').query({ q: 'alice*localhost', type });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
      },
    );
  });

  describe('response headers', () => {
    test('serves successful lookups as application/json', async () => {
      prisma.user.findFirst.mockResolvedValue({
        address: ACCOUNT_ID,
        memoType: null,
        memo: null,
        flaggedAt: null,
      });

      const res = await request(app)
        .get('/federation')
        .query({ q: 'json*localhost', type: 'name' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    test('serves error responses as application/json', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .get('/federation')
        .query({ q: 'ghost*localhost', type: 'name' });

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    test('sets an ETag and answers a matching If-None-Match with 304', async () => {
      prisma.user.findFirst.mockResolvedValue({
        address: ACCOUNT_ID,
        memoType: null,
        memo: null,
        flaggedAt: null,
      });

      const first = await request(app)
        .get('/federation')
        .query({ q: 'etag*localhost', type: 'name' });

      expect(first.status).toBe(200);
      expect(first.headers.etag).toBeDefined();

      const second = await request(app)
        .get('/federation')
        .query({ q: 'etag*localhost', type: 'name' })
        .set('If-None-Match', first.headers.etag);

      expect(second.status).toBe(304);
    });
  });
});

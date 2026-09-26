'use strict';

// #613 — an address may carry up to five federation usernames (aliases).
// The first registered is the primary; reverse (type=id) federation lookups
// resolve to it. These tests cover registration slot assignment, the cap,
// and the primary-first ordering of the reverse lookup.

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: {
    isValidEd25519PublicKey: jest.fn(
      (key) => typeof key === 'string' && key.startsWith('G') && key.length === 56,
    ),
  },
}));

jest.mock('pdfkit', () => jest.fn());
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
  isPrismaConnectionError: () => false,
}));

jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({
    success: true,
    accountId: 'GDUMMY',
    requiredThreshold: 1,
    totalWeight: 1,
    signerCount: 1,
    errorMessage: null,
  }),
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

const ADDRESS = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';

describe('#613 username aliases', () => {
  let app;
  let prisma;

  beforeEach(() => {
    jest.resetModules();
    ({ app } = require('../server'));
    ({ prisma } = require('../prismaClient'));
    prisma.user.findFirst.mockReset();
    prisma.user.count.mockReset();
    prisma.user.create.mockReset();
    prisma.user.create.mockResolvedValue({ username: 'x*localhost', address: ADDRESS });
  });

  describe('POST /register slot assignment', () => {
    test('the first username for an address is registered as the primary', async () => {
      prisma.user.count.mockResolvedValue(0);

      const res = await request(app)
        .post('/register')
        .send({ username: 'payments', address: ADDRESS });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ ok: true, is_primary: true });
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ username: 'payments*localhost', isPrimary: true }),
        }),
      );
    });

    test.each([1, 2, 3, 4])(
      'username number %d for an address is registered as a non-primary alias',
      async (existing) => {
        prisma.user.count.mockResolvedValue(existing);

        const res = await request(app)
          .post('/register')
          .send({ username: 'billing', address: ADDRESS });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ ok: true, is_primary: false });
        expect(prisma.user.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ isPrimary: false }),
          }),
        );
      },
    );

    test('the sixth username for an address is rejected with 409', async () => {
      prisma.user.count.mockResolvedValue(5);

      const res = await request(app)
        .post('/register')
        .send({ username: 'overflow', address: ADDRESS });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toMatch(/maximum of 5/);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    test('the alias-count check filters by address and excludes soft-deleted rows', async () => {
      prisma.user.count.mockResolvedValue(0);

      await request(app).post('/register').send({ username: 'payments', address: ADDRESS });

      expect(prisma.user.count).toHaveBeenCalledWith({
        where: { address: ADDRESS, deletedAt: null },
      });
    });
  });

  describe('GET /federation type=id returns the primary username', () => {
    test('resolves the address to its primary username, ordered primary-first', async () => {
      prisma.user.findFirst.mockResolvedValue({
        username: 'payments',
        address: ADDRESS,
        memoType: null,
        memo: null,
        flaggedAt: null,
      });

      const res = await request(app).get('/federation').query({ q: ADDRESS, type: 'id' });

      expect(res.status).toBe(200);
      expect(res.body.stellar_address).toBe('payments*localhost');
      expect(res.body.account_id).toBe(ADDRESS);

      const arg = prisma.user.findFirst.mock.calls[0][0];
      expect(arg.orderBy).toEqual([{ isPrimary: 'desc' }, { createdAt: 'asc' }]);
    });
  });
});

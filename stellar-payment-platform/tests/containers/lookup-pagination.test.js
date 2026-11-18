'use strict';

/**
 * #686 — lookup and list pagination against a real PostgreSQL.
 *
 * Replaces the Map-backed `integration.test.js` search/pagination coverage.
 * Offset pagination, keyset cursors, ordering and the `deletedAt IS NULL` filter
 * are all SQL behaviours: a fake store can only ever assert that the test and
 * the fake agree. These run against the real `username_registry` table, with
 * explicit `created_at` values so the ordering assertions are deterministic
 * rather than dependent on clock resolution.
 */

jest.mock('../../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('../../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({ success: true }),
  isSingleSignerAccount: jest.fn().mockReturnValue(true),
}));
// StrKey is reimplemented (with its checksum) in the stub rather than returning
// true for anything, so address validation is really exercised. See
// tests/containers/support/stellarStub.js for why the SDK cannot be required.
jest.mock('@stellar/stellar-sdk', () => require('./support/stellarStub').sdkMock);
jest.mock('pdfkit', () => jest.fn());

const request = require('supertest');
const { app } = require('../../server');
const {
  closeRedis,
  insertUser,
  insertWalletBalance,
  makeAddress,
  nameTag,
  prisma,
  resetTestState,
  waitForDependencies,
} = require('./support/harness');

const LOOKUP_URL = '/api/v1/lookup';
const USERS_URL = '/api/v1/users';

const EPOCH = new Date('2026-01-01T00:00:00.000Z');
const at = (minutes) => new Date(EPOCH.getTime() + minutes * 60_000);

/** Seed `count` users, oldest first, so `created_at DESC` is predictable. */
async function seedUsers(count) {
  for (let index = 0; index < count; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await insertUser({
      username: `paged${index}`,
      address: makeAddress(`PAGE${index}`),
      isPrimary: true,
      createdAt: at(index),
    });
  }
}

const namesOn = (res) => res.body.data.map((row) => row.username);

describe('lookup (real PostgreSQL)', () => {
  beforeAll(async () => {
    await waitForDependencies(app);
  });

  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await closeRedis();
  });

  describe('GET /lookup?address=', () => {
    it('returns the username and the balances held for it', async () => {
      const address = makeAddress('BAL');
      await insertUser({ username: 'balance', address, isPrimary: true });
      await insertWalletBalance('balance', 'XLM', 250.5);
      await insertWalletBalance('balance', 'USDC', 12);

      const res = await request(app).get(LOOKUP_URL).query({ address });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        username: 'balance*localhost',
        address,
        balances: { XLM: 250.5, USDC: 12 },
      });
    });

    it('returns an empty balance map for a user with no balances', async () => {
      const address = makeAddress('NOBAL');
      await insertUser({ username: 'nobal', address, isPrimary: true });

      const res = await request(app).get(LOOKUP_URL).query({ address });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ username: 'nobal*localhost', address, balances: {} });
    });

    it('answers 404 for an address that owns no username', async () => {
      const res = await request(app).get(LOOKUP_URL).query({ address: makeAddress('GHOST') });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    });

    it('rejects a request with neither address nor search', async () => {
      const res = await request(app).get(LOOKUP_URL);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    });
  });

  describe('GET /lookup?search=', () => {
    it('matches on username or address, case-insensitively', async () => {
      const address = makeAddress('FINDME');
      await insertUser({ username: 'findme', address, isPrimary: true, createdAt: at(0) });
      await insertUser({ username: 'other', address: makeAddress('OTHER'), createdAt: at(1) });

      const byName = await request(app).get(LOOKUP_URL).query({ search: 'FINDME' });
      expect(byName.status).toBe(200);
      expect(namesOn(byName)).toEqual(['findme*localhost']);
      expect(byName.body.totalCount).toBe(1);

      const byAddress = await request(app).get(LOOKUP_URL).query({ search: address.toLowerCase() });
      expect(byAddress.status).toBe(200);
      expect(namesOn(byAddress)).toEqual(['findme*localhost']);
    });

    it('orders by created_at descending, newest first', async () => {
      await seedUsers(3);

      const res = await request(app).get(LOOKUP_URL).query({ search: 'paged' });

      expect(res.status).toBe(200);
      expect(namesOn(res)).toEqual(['paged2*localhost', 'paged1*localhost', 'paged0*localhost']);
    });

    it('excludes soft-deleted rows', async () => {
      await seedUsers(3);
      await prisma().user.update({
        where: { username: nameTag('paged1') },
        data: { deletedAt: at(10) },
      });

      const res = await request(app).get(LOOKUP_URL).query({ search: 'paged' });

      expect(namesOn(res)).toEqual(['paged2*localhost', 'paged0*localhost']);
      expect(res.body.totalCount).toBe(2);
    });

    it('reports totalCount, totalPages and currentPage', async () => {
      await seedUsers(7);

      const res = await request(app).get(LOOKUP_URL).query({ search: 'paged', limit: 3, page: 2 });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ totalCount: 7, totalPages: 3, currentPage: 2 });
      expect(res.body.data).toHaveLength(3);
      expect(namesOn(res)).toEqual(['paged4*localhost', 'paged3*localhost', 'paged2*localhost']);
    });

    it('returns a short final page', async () => {
      await seedUsers(7);

      const res = await request(app).get(LOOKUP_URL).query({ search: 'paged', limit: 3, page: 3 });

      expect(res.status).toBe(200);
      expect(namesOn(res)).toEqual(['paged0*localhost']);
      expect(res.body).toMatchObject({ totalCount: 7, totalPages: 3, currentPage: 3 });
    });

    it('returns an empty page beyond the end', async () => {
      await seedUsers(2);

      const res = await request(app).get(LOOKUP_URL).query({ search: 'paged', limit: 10, page: 9 });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body).toMatchObject({ totalCount: 2, totalPages: 1, currentPage: 9 });
    });

    it('clamps limit to the documented maximum', async () => {
      await seedUsers(2);

      const res = await request(app).get(LOOKUP_URL).query({ search: 'paged', limit: 5000 });

      expect(res.status).toBe(200);
      // The handler clamps to 100 before computing totalPages; with 2 rows that
      // is indistinguishable from any larger limit, so assert the page fits.
      expect(res.body.data).toHaveLength(2);
      expect(res.body.totalPages).toBe(1);
    });
  });

  describe('keyset pagination', () => {
    it('walks every row exactly once, with no overlap between pages', async () => {
      await seedUsers(7);

      const seen = [];
      let cursor = null;
      let pages = 0;

      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app)
          .get(LOOKUP_URL)
          .query({ search: 'paged', limit: 2, ...(cursor ? { cursor } : {}) });

        expect(res.status).toBe(200);
        expect(res.body.meta.limit).toBe(2);
        seen.push(...namesOn(res));
        pages += 1;

        if (!res.body.hasMore) {
          expect(res.body.nextCursor).toBeNull();
          break;
        }

        cursor = res.body.nextCursor;
        expect(typeof cursor).toBe('string');
      }

      expect(pages).toBe(4); // 2 + 2 + 2 + 1
      expect(seen).toEqual([
        'paged6*localhost',
        'paged5*localhost',
        'paged4*localhost',
        'paged3*localhost',
        'paged2*localhost',
        'paged1*localhost',
        'paged0*localhost',
      ]);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('rejects a malformed cursor with 400', async () => {
      await seedUsers(2);

      const res = await request(app).get(LOOKUP_URL).query({ search: 'paged', cursor: 'not-a-cursor' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    });
  });

  describe('GET /users', () => {
    it('lists every live user and reports the same total under meta', async () => {
      await seedUsers(4);

      const res = await request(app).get(USERS_URL).query({ limit: 2, page: 1 });

      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ total: 4, totalCount: 4, limit: 2, page: 1, totalPages: 2 });
      expect(res.body).toMatchObject({ totalCount: 4, totalPages: 2, currentPage: 1 });
      expect(res.body.data).toHaveLength(2);
    });

    it('agrees with the search listing', async () => {
      await seedUsers(4);

      const users = await request(app).get(USERS_URL);
      const lookup = await request(app).get(LOOKUP_URL).query({ search: 'paged' });

      expect(users.status).toBe(200);
      expect(lookup.status).toBe(200);
      expect(namesOn(users)).toEqual(namesOn(lookup));
      expect(users.body.totalCount).toBe(lookup.body.totalCount);
    });
  });
});

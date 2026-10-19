'use strict';

/**
 * #686 — admin routes against a real PostgreSQL.
 *
 * Replaces the Map-backed `tests/e2e/admin.e2e.test.js`. These endpoints are
 * almost pure SQL: `updateMany` over every alias an address owns, an audit trail
 * written after the response has already been flushed, a keyset walk that
 * streams a whole table, and date-range filtering. A mock asserted the handler
 * agreed with itself; these assert the rows are really in the table.
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
  eventually,
  insertPayments,
  insertUser,
  makeAddress,
  nameTag,
  prisma,
  resetTestState,
  waitForDependencies,
} = require('./support/harness');

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const BLOCK_URL = '/api/v1/admin/block';
const EXPORT_URL = '/api/v1/admin/export';
const AUDIT_LOGS_URL = '/api/v1/admin/audit-logs';

const asAdmin = (req) => req.set('x-api-key', ADMIN_API_KEY);

const EPOCH = new Date('2026-01-01T00:00:00.000Z');
const at = (days) => new Date(EPOCH.getTime() + days * 24 * 60 * 60 * 1000);

const paymentRow = (overrides) => ({
  fromAddress: makeAddress('FROM'),
  toAddress: makeAddress('TO'),
  amount: 10,
  status: 'completed',
  ...overrides,
});

describe('admin (real PostgreSQL)', () => {
  beforeAll(async () => {
    await waitForDependencies(app);
  });

  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await closeRedis();
  });

  describe('authentication', () => {
    it('is configured with an admin key by globalSetup', () => {
      expect(typeof ADMIN_API_KEY).toBe('string');
      expect(ADMIN_API_KEY.length).toBeGreaterThan(0);
    });

    it('rejects a missing or wrong API key on every admin route', async () => {
      const unauthenticated = [
        request(app).post(BLOCK_URL).send({ address: makeAddress('X') }),
        request(app).get(EXPORT_URL),
        request(app).get(EXPORT_URL).set('x-api-key', 'wrong-key'),
        request(app).get(AUDIT_LOGS_URL),
        request(app).get('/api/v1/admin/dlq'),
        request(app).get('/api/v1/admin/webhooks/health'),
      ];

      for (const req of unauthenticated) {
        // eslint-disable-next-line no-await-in-loop
        const res = await req;
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ error: 'Unauthorized: Invalid or missing API key' });
      }

      expect(await prisma().user.count()).toBe(0);
    });

    it('accepts the key from the query string as well as the header', async () => {
      const res = await request(app).get(AUDIT_LOGS_URL).query({ api_key: ADMIN_API_KEY });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, count: 0, data: [] });
    });
  });

  describe('POST /admin/block', () => {
    it('flags every username the address owns, primary first', async () => {
      const address = makeAddress('BLOCK');
      await insertUser({ username: 'blockprimary', address, isPrimary: true, createdAt: at(0) });
      await insertUser({ username: 'blockalias', address, isPrimary: false, createdAt: at(1) });

      const res = await asAdmin(request(app).post(BLOCK_URL)).send({ address });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        message: 'Address successfully blocked',
        address,
        username: 'blockprimary*localhost',
        usernames: ['blockprimary*localhost', 'blockalias*localhost'],
      });
      expect(typeof res.body.flaggedAt).toBe('string');

      // #613 dropped the unique index on address, so this is an updateMany over
      // every alias — a single-row update would silently under-block.
      const rows = await prisma().user.findMany({ where: { address } });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.flaggedAt).toBeInstanceOf(Date);
      }
    });

    it('leaves an already-soft-deleted username out of the block', async () => {
      const address = makeAddress('BLOCKDEL');
      await insertUser({ username: 'blocklive', address, isPrimary: true, createdAt: at(0) });
      await insertUser({ username: 'blockgone', address, isPrimary: false, deletedAt: at(1) });

      const res = await asAdmin(request(app).post(BLOCK_URL)).send({ address });

      expect(res.status).toBe(200);
      expect(res.body.usernames).toEqual(['blocklive*localhost']);

      const deleted = await prisma().user.findUnique({ where: { username: nameTag('blockgone') } });
      expect(deleted.flaggedAt).toBeNull();
    });

    it('records a user.blocked activity row for each username it flagged', async () => {
      const address = makeAddress('ACT');
      await insertUser({ username: 'actone', address, isPrimary: true, createdAt: at(0) });
      await insertUser({ username: 'acttwo', address, isPrimary: false, createdAt: at(1) });

      expect((await asAdmin(request(app).post(BLOCK_URL)).send({ address })).status).toBe(200);

      const activities = await eventually(() =>
        prisma().activityLog.findMany({ where: { action: 'user.blocked' } }).then((rows) =>
          rows.length === 2 ? rows : null,
        ),
      );

      expect(activities.map((row) => row.username).sort()).toEqual([
        'actone*localhost',
        'acttwo*localhost',
      ]);
      for (const row of activities) {
        expect(row.metadata).toMatchObject({ address });
      }
    });

    it('answers 404 for an address it does not know and 400 for a malformed body', async () => {
      const unknown = await asAdmin(request(app).post(BLOCK_URL)).send({ address: makeAddress('NOBODY') });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ error: 'Address not found' });

      const malformed = await asAdmin(request(app).post(BLOCK_URL)).send({ address: 42 });
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({ error: 'Missing or invalid address' });
    });
  });

  describe('audit trail', () => {
    it('persists an audit row after the response, with sensitive fields redacted', async () => {
      const address = makeAddress('AUDIT');
      await insertUser({ username: 'audited', address, isPrimary: true, createdAt: at(0) });

      const res = await asAdmin(request(app).post(BLOCK_URL)).send({ address, token: 'super-secret' });
      expect(res.status).toBe(200);

      // The write happens on `res.on('finish')` via setImmediate, i.e. after the
      // response has already been flushed — poll rather than sleep.
      const row = await eventually(() =>
        prisma().auditLog.findFirst({ where: { path: BLOCK_URL } }).then((found) => found || null),
      );

      expect(row).toMatchObject({
        method: 'POST',
        path: BLOCK_URL,
        userId: 'admin',
        statusCode: 200,
      });
      expect(row.action).toContain('POST');
      expect(JSON.parse(row.payload)).toEqual({ address, token: '[REDACTED]' });
    });

    it('exposes the trail newest first, paginated by limit', async () => {
      const address = makeAddress('TRAIL');
      await insertUser({ username: 'trailed', address, isPrimary: true, createdAt: at(0) });
      await asAdmin(request(app).post(BLOCK_URL)).send({ address });
      await eventually(() => prisma().auditLog.count().then((n) => (n > 0 ? n : null)));

      const res = await asAdmin(request(app).get(AUDIT_LOGS_URL)).query({ limit: 1 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(1);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].path).toBe(BLOCK_URL);
    });
  });

  describe('GET /admin/export', () => {
    beforeEach(async () => {
      await insertPayments([
        paymentRow({ id: 'pay-1', amount: 1.5, assetCode: 'XLM', createdAt: at(1) }),
        paymentRow({ id: 'pay-2', amount: 2.5, assetCode: 'USDC', createdAt: at(2) }),
        paymentRow({ id: 'pay-3', amount: 3.5, createdAt: at(3) }),
      ]);
    });

    it('streams every payment as NDJSON, oldest first', async () => {
      const res = await asAdmin(request(app).get(EXPORT_URL)).query({ format: 'json' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
      expect(res.headers['content-disposition']).toMatch(/admin-export-.*\.ndjson/);

      const lines = res.text.trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.map((row) => row.id)).toEqual(['pay-1', 'pay-2', 'pay-3']);
      expect(lines.map((row) => row.amount)).toEqual([1.5, 2.5, 3.5]);
      expect(lines[0].fraudStatus).toBe('clear');
    });

    it('defaults to CSV with a header row', async () => {
      const res = await asAdmin(request(app).get(EXPORT_URL));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);

      const [header, ...rows] = res.text.trim().split('\n');
      expect(header.startsWith('"id"')).toBe(true);
      expect(header).toContain('"fromAddress"');
      expect(header).toContain('"amount"');
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain('pay-1');
    });

    it('applies the startDate / endDate range', async () => {
      const res = await asAdmin(request(app).get(EXPORT_URL)).query({
        format: 'json',
        startDate: at(2).toISOString(),
        endDate: at(3).toISOString(),
      });

      expect(res.status).toBe(200);
      const ids = res.text.trim().split('\n').map((line) => JSON.parse(line).id);
      expect(ids).toEqual(['pay-2', 'pay-3']);
    });

    it('rejects an unparseable or inverted date range', async () => {
      const bad = await asAdmin(request(app).get(EXPORT_URL)).query({ startDate: 'not-a-date' });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ error: 'Invalid startDate' });

      const inverted = await asAdmin(request(app).get(EXPORT_URL)).query({
        startDate: at(3).toISOString(),
        endDate: at(1).toISOString(),
      });
      expect(inverted.status).toBe(400);
      expect(inverted.body).toMatchObject({ error: 'startDate must not be after endDate' });
    });

    it('orders rows that share a timestamp by id, without dropping any', async () => {
      await insertPayments([
        paymentRow({ id: 'pay-tie-b', createdAt: at(5) }),
        paymentRow({ id: 'pay-tie-a', createdAt: at(5) }),
      ]);

      const res = await asAdmin(request(app).get(EXPORT_URL)).query({ format: 'json' });
      const ids = res.text.trim().split('\n').map((line) => JSON.parse(line).id);

      expect(ids.slice(0, 3)).toEqual(['pay-1', 'pay-2', 'pay-3']);
      expect(ids.slice(3)).toEqual(['pay-tie-a', 'pay-tie-b']);
    });
  });
});

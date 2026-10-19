'use strict';

/**
 * #686 — federation lookups against a real PostgreSQL.
 *
 * Replaces the Map-backed `tests/e2e/federation.e2e.test.js`. The federation
 * router is the one that most benefits from a real database: name resolution,
 * reverse (type=id) resolution to the *primary* username, memo passthrough and
 * cache invalidation all hinge on what Postgres actually returns, and a Map
 * could answer any of them convincingly without being right.
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

const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../server');
const {
  closeRedis,
  makeAddress,
  prisma,
  resetTestState,
  waitForDependencies,
} = require('./support/harness');

const FEDERATION_URL = '/api/v1/federation';

const byName = (q) => request(app).get(FEDERATION_URL).query({ q, type: 'name' });
const byId = (q) => request(app).get(FEDERATION_URL).query({ q, type: 'id' });

const register = (body) => request(app).post('/api/v1/register').send(body);

describe('federation (real PostgreSQL)', () => {
  beforeAll(async () => {
    await waitForDependencies(app);
  });

  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await closeRedis();
  });

  it('resolves a name to the account stored in the database', async () => {
    const address = makeAddress('FED');
    expect((await register({ username: 'federated', address })).status).toBe(201);

    const res = await byName('federated');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stellar_address: 'federated*localhost', account_id: address });
  });

  it('accepts the name bare, fully qualified, and in any case', async () => {
    const address = makeAddress('FEDCASE');
    expect((await register({ username: 'Casey', address })).status).toBe(201);

    for (const q of ['Casey', 'casey', 'CASEY', 'casey*localhost', 'Casey*LOCALHOST']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await byName(q);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stellar_address: 'casey*localhost', account_id: address });
    }
  });

  it('defaults to a name lookup when type is omitted', async () => {
    const address = makeAddress('FEDDEFAULT');
    expect((await register({ username: 'deflt', address })).status).toBe(201);

    const res = await request(app).get(FEDERATION_URL).query({ q: 'deflt' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stellar_address: 'deflt*localhost', account_id: address });
  });

  it('returns the memo registered alongside the username', async () => {
    const address = makeAddress('FEDMEMO');
    expect(
      (await register({ username: 'memoed', address, memo_type: 'text', memo: 'gift-7' })).status,
    ).toBe(201);

    const res = await byName('memoed');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stellar_address: 'memoed*localhost',
      account_id: address,
      memo_type: 'text',
      memo: 'gift-7',
    });
  });

  it('resolves a reverse lookup to the primary username of the account', async () => {
    const address = makeAddress('PRIMARY');
    expect((await register({ username: 'zeroth', address })).status).toBe(201);
    expect((await register({ username: 'primary', address })).status).toBe(201);
    expect((await register({ username: 'aliasprimary', address })).status).toBe(201);

    // Registration order decides the primary, and the query relies on
    // PRIMARY_USERNAME_ORDER to honour it — a Map cannot express that.
    const res = await byId(address);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stellar_address: 'zeroth*localhost', account_id: address });

    const primaryRows = await prisma().user.findMany({ where: { address, isPrimary: true } });
    expect(primaryRows).toHaveLength(1);
    expect(primaryRows[0].username).toBe('zeroth*localhost');
  });

  it('matches a reverse lookup case-insensitively', async () => {
    const address = makeAddress('FEDIDCASE');
    expect((await register({ username: 'idcase', address })).status).toBe(201);

    const res = await byId(address.toLowerCase());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stellar_address: 'idcase*localhost', account_id: address });
  });

  it('answers 404 for an unknown name and an unknown address', async () => {
    const name = await byName('nosuchuser');
    expect(name.status).toBe(404);
    expect(name.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });

    const id = await byId(makeAddress('UNKNOWN'));
    expect(id.status).toBe(404);
    expect(id.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('rejects an unsupported query type', async () => {
    const res = await request(app).get(FEDERATION_URL).query({ q: 'anything', type: 'sideways' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('rejects a lookup with no query', async () => {
    const res = await request(app).get(FEDERATION_URL);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  describe('caching', () => {
    it('serves a conditional repeat request with 304 and an empty body', async () => {
      const address = makeAddress('FEDETAG');
      expect((await register({ username: 'etagged', address })).status).toBe(201);

      const first = await byName('etagged');
      expect(first.status).toBe(200);

      const etag = first.headers.etag;
      expect(etag).toBeTruthy();
      expect(etag).toBe(
        `"${crypto.createHash('sha256').update(JSON.stringify(first.body), 'utf8').digest('hex')}"`,
      );

      const second = await request(app)
        .get(FEDERATION_URL)
        .query({ q: 'etagged', type: 'name' })
        .set('If-None-Match', etag);

      expect(second.status).toBe(304);
      expect(second.text).toBeFalsy();
    });

    it('re-reads the database after the cache is invalidated by unregistering', async () => {
      const address = makeAddress('FEDINVALIDATE');
      expect((await register({ username: 'revoked', address })).status).toBe(201);

      // First lookup populates the federation cache.
      expect((await byName('revoked')).status).toBe(200);

      // Unregistering soft-deletes the row and invalidates the cache entry, so
      // the next lookup must reach Postgres instead of replaying the cache.
      const del = await request(app).delete('/api/v1/register/revoked');
      expect(del.status).toBe(200);

      const afterDelete = await byName('revoked');
      expect(afterDelete.status).toBe(404);
      expect(afterDelete.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });
  });
});

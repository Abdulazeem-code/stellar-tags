'use strict';

/**
 * #686 — registration against a real PostgreSQL.
 *
 * Replaces the Map-backed `integration.test.js` / `tests/e2e/registration.e2e.test.js`
 * suites. Everything asserted here is the database's answer, not a fake's:
 * the unique primary key that produces the 409, the `is_primary` flag, the
 * soft-delete column, and the raw row that lands in `username_registry`.
 *
 * Only the Stellar network is stubbed — Horizon is unreachable from CI, and
 * `@stellar/stellar-sdk` ships ESM that Jest's CommonJS runtime cannot require.
 * Prisma, the `pg` pool and Redis are all real.
 */

jest.mock('../../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('../../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(async (address) => ({
    success: true,
    accountId: address,
    signerCount: 1,
    thresholdMet: true,
    requiredThreshold: 1,
    totalWeight: 1,
  })),
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
  makeAddress,
  prisma,
  resetTestState,
  waitForDependencies,
} = require('./support/harness');

const REGISTER_URL = '/api/v1/register';

const register = (body) => request(app).post(REGISTER_URL).send(body);

describe('registration (real PostgreSQL)', () => {
  beforeAll(async () => {
    await waitForDependencies(app);
  });

  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await closeRedis();
  });

  it('stores the row and returns the federation address', async () => {
    const address = makeAddress('ALICE');

    const res = await register({ username: 'integrationuser', address });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      username: 'integrationuser*localhost',
      address,
      federation_address: 'integrationuser*localhost',
      is_primary: true,
    });

    // The point of the phase: the row really is in Postgres, with the columns
    // and defaults the migration chain declares.
    const rows = await prisma().user.findMany({ where: { username: 'integrationuser*localhost' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      username: 'integrationuser*localhost',
      address,
      isPrimary: true,
      memoType: null,
      memo: null,
      deletedAt: null,
      flaggedAt: null,
    });
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate username with 409 (unique primary key)', async () => {
    const first = makeAddress('FIRST');
    const second = makeAddress('SECOND');

    expect((await register({ username: 'duplicated', address: first })).status).toBe(201);

    const res = await register({ username: 'duplicated', address: second });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, error: { code: 'CONFLICT' } });

    // The failed insert must not have created anything.
    const rows = await prisma().user.findMany({ where: { username: 'duplicated*localhost' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe(first);
  });

  it('folds username case, so a differently-cased duplicate is rejected', async () => {
    const address = makeAddress('CASE');

    expect((await register({ username: 'MixedCase', address })).status).toBe(201);

    const res = await register({ username: 'mixedcase', address: makeAddress('CASE2') });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'CONFLICT' } });

    const rows = await prisma().user.findMany({ where: { address } });
    expect(rows).toHaveLength(1);
  });

  it('allows five usernames per address and rejects the sixth', async () => {
    const address = makeAddress('ALIASES');

    for (let index = 1; index <= 5; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await register({ username: `alias${index}`, address });
      expect(res.status).toBe(201);
      expect(res.body.is_primary).toBe(index === 1);
    }

    const overflow = await register({ username: 'alias6', address });

    expect(overflow.status).toBe(409);
    expect(overflow.body).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(await prisma().user.count({ where: { address } })).toBe(5);
  });

  it('persists memo fields and returns them', async () => {
    const address = makeAddress('MEMO');

    const res = await register({ username: 'memouser', address, memo_type: 'text', memo: 'invoice-42' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ memo_type: 'text', memo: 'invoice-42' });

    const row = await prisma().user.findUnique({ where: { username: 'memouser*localhost' } });
    expect(row).toMatchObject({ memoType: 'text', memo: 'invoice-42' });
  });

  it('rejects a secret key (an address starting with S)', async () => {
    // Stellar secret keys are S…; the handler refuses them outright.
    const secretKey = `S${makeAddress('SECRET').slice(1)}`;

    const res = await register({ username: 'secretuser', address: secretKey });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await prisma().user.count()).toBe(0);
  });

  it('rejects an address that is not a valid Stellar public key', async () => {
    // The stub reimplements StrKey's checksum, so a corrupted key is caught the
    // way the real validator would catch it.
    const valid = makeAddress('CORRUPT');
    const corrupted = `${valid.slice(0, 55)}${valid[55] === 'A' ? 'B' : 'A'}`;

    const res = await register({ username: 'corruptuser', address: corrupted });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { message: 'Invalid Stellar Public Key format.' } });
    expect(await prisma().user.count()).toBe(0);
  });

  it('rejects a payload that fails schema validation with 422', async () => {
    const res = await register({ address: makeAddress('NOUSER') });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await prisma().user.count()).toBe(0);
  });

  it('rejects unsupported methods on the register path with 405', async () => {
    const res = await request(app).get(REGISTER_URL);

    expect(res.status).toBe(405);
    expect(res.body).toMatchObject({ error: { code: 'METHOD_NOT_ALLOWED' } });
  });

  describe('soft delete', () => {
    it('keeps the row but hides it from every read path', async () => {
      const address = makeAddress('GONE');
      expect((await register({ username: 'goner', address })).status).toBe(201);

      const del = await request(app).delete(`${REGISTER_URL}/goner`);

      expect(del.status).toBe(200);
      expect(del.body).toMatchObject({ ok: true, username: 'goner*localhost', deleted: true });

      // Soft delete, not DELETE: the row survives with a timestamp.
      const row = await prisma().user.findUnique({ where: { username: 'goner*localhost' } });
      expect(row).not.toBeNull();
      expect(row.deletedAt).toBeInstanceOf(Date);

      // ...and every read path filters on deletedAt IS NULL.
      const lookup = await request(app).get(`/api/v1/lookup?address=${address}`);
      expect(lookup.status).toBe(404);

      const federation = await request(app).get('/api/v1/federation?q=goner&type=name');
      expect(federation.status).toBe(404);
    });

    it('still occupies the primary key, so the username cannot be re-registered', async () => {
      const address = makeAddress('RETAKE');
      expect((await register({ username: 'retaken', address })).status).toBe(201);
      expect((await request(app).delete(`${REGISTER_URL}/retaken`)).status).toBe(200);

      const res = await register({ username: 'retaken', address: makeAddress('OTHER') });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: 'CONFLICT' } });
    });

    it('answers 404 when the username does not exist', async () => {
      const res = await request(app).delete(`${REGISTER_URL}/neverregistered`);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });
  });
});

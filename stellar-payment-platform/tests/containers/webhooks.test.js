'use strict';

/**
 * #686 — webhook registration against a real PostgreSQL.
 *
 * Replaces the Map-backed `tests/e2e/webhooks.e2e.test.js`. The behaviour under
 * test is almost entirely relational: the `(username, url)` unique constraint
 * that turns a duplicate registration into a 409, the `username` scoping that
 * keeps one user's webhooks invisible and undeletable by another, and the
 * `ON DELETE CASCADE` from `username_registry`. None of that is observable
 * through a Map.
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
  insertUser,
  makeAddress,
  nameTag,
  prisma,
  resetTestState,
  waitForDependencies,
} = require('./support/harness');

const WEBHOOKS_URL = '/api/v1/webhooks';
const VERIFY_URL = '/api/v1/webhooks/verify-test';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Credentials the auth layer accepts: a signature-shaped value, no signer. */
const credentialsFor = (username) => ({ username, signature: makeAddress('SIG') });

const createWebhook = (username, url) =>
  request(app).post(WEBHOOKS_URL).send({ ...credentialsFor(username), url });

const listWebhooks = (username) => request(app).get(WEBHOOKS_URL).send(credentialsFor(username));

const deleteWebhook = (username, id) =>
  request(app).delete(`${WEBHOOKS_URL}/${id}`).send(credentialsFor(username));

describe('webhooks (real PostgreSQL)', () => {
  let owner;
  let other;

  beforeAll(async () => {
    await waitForDependencies(app);
  });

  beforeEach(async () => {
    await resetTestState();
    owner = { username: 'hookowner', address: makeAddress('HOOK') };
    other = { username: 'hookother', address: makeAddress('OTHER') };
    await insertUser(owner);
    await insertUser(other);
  });

  afterAll(async () => {
    await closeRedis();
  });

  describe('POST /webhooks', () => {
    it('persists the webhook and returns the secret exactly once', async () => {
      const res = await createWebhook('hookowner', 'https://merchant.example/hooks/stellar');

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.webhook).toMatchObject({
        username: 'hookowner*localhost',
        url: 'https://merchant.example/hooks/stellar',
      });
      expect(res.body.webhook.id).toMatch(UUID);
      expect(res.body.webhook.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof res.body.webhook.created_at).toBe('string');

      const rows = await prisma().webhook.findMany({ where: { username: nameTag('hookowner') } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: res.body.webhook.id,
        url: 'https://merchant.example/hooks/stellar',
        secret: res.body.webhook.secret,
        events: ['*'],
        lastSentAt: null,
        failingSince: null,
      });
    });

    it('gives each webhook an independent secret', async () => {
      const first = await createWebhook('hookowner', 'https://merchant.example/hooks/one');
      const second = await createWebhook('hookowner', 'https://merchant.example/hooks/two');

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.webhook.secret).not.toBe(first.body.webhook.secret);
    });

    it('rejects a duplicate URL for the same user with 409', async () => {
      const url = 'https://merchant.example/hooks/same';
      expect((await createWebhook('hookowner', url)).status).toBe(201);

      const res = await createWebhook('hookowner', url);

      expect(res.status).toBe(409);
      expect(await prisma().webhook.count({ where: { username: nameTag('hookowner') } })).toBe(1);
    });

    it('allows the same URL under a different user', async () => {
      const url = 'https://merchant.example/hooks/shared';

      expect((await createWebhook('hookowner', url)).status).toBe(201);
      expect((await createWebhook('hookother', url)).status).toBe(201);

      // The constraint is (username, url), not url alone.
      expect(await prisma().webhook.count()).toBe(2);
    });

    it('rejects a URL that is not http or https', async () => {
      for (const url of ['ftp://merchant.example/hook', 'not a url', 'javascript:alert(1)']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await createWebhook('hookowner', url);
        expect(res.status).toBe(400);
      }

      expect(await prisma().webhook.count()).toBe(0);
    });

    it('rejects a non-JSON body with 415', async () => {
      const res = await request(app)
        .post(WEBHOOKS_URL)
        .set('Content-Type', 'text/plain')
        .send('url=https://merchant.example/hooks/plain');

      expect(res.status).toBe(415);
      expect(await prisma().webhook.count()).toBe(0);
    });

    it('answers 400 for missing credentials and 404 for an unknown username', async () => {
      const noUsername = await request(app)
        .post(WEBHOOKS_URL)
        .send({ url: 'https://merchant.example/hooks/x' });
      expect(noUsername.status).toBe(400);

      const noSignature = await request(app)
        .post(WEBHOOKS_URL)
        .send({ username: 'hookowner', url: 'https://merchant.example/hooks/y' });
      expect(noSignature.status).toBe(400);

      const unknown = await createWebhook('nosuchuser', 'https://merchant.example/hooks/z');
      expect(unknown.status).toBe(404);

      expect(await prisma().webhook.count()).toBe(0);
    });
  });

  describe('GET /webhooks', () => {
    it('lists the caller’s webhooks, newest first', async () => {
      const first = await createWebhook('hookowner', 'https://merchant.example/hooks/older');
      const second = await createWebhook('hookowner', 'https://merchant.example/hooks/newer');
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      // Two HTTP round trips are not a reliable ordering guarantee at
      // millisecond timestamp resolution, so pin the column the sort uses.
      await prisma().webhook.update({
        where: { id: first.body.webhook.id },
        data: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
      });
      await prisma().webhook.update({
        where: { id: second.body.webhook.id },
        data: { createdAt: new Date('2026-02-01T00:00:00.000Z') },
      });

      const res = await listWebhooks('hookowner');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.webhooks).toHaveLength(2);
      expect(res.body.webhooks.map((w) => w.id)).toEqual([second.body.webhook.id, first.body.webhook.id]);
      // The secret is never echoed back on a read.
      expect(res.body.webhooks[0].secret).toBeUndefined();
      expect(res.body.webhooks[0]).toMatchObject({ last_sent_at: null, failing_since: null });
    });

    it('never returns another user’s webhooks', async () => {
      expect((await createWebhook('hookowner', 'https://merchant.example/hooks/mine')).status).toBe(201);

      const res = await listWebhooks('hookother');

      expect(res.status).toBe(200);
      expect(res.body.webhooks).toEqual([]);
    });
  });

  describe('DELETE /webhooks/:id', () => {
    it('deletes the caller’s webhook and reports a second attempt as missing', async () => {
      const created = await createWebhook('hookowner', 'https://merchant.example/hooks/temp');
      const id = created.body.webhook.id;

      const res = await deleteWebhook('hookowner', id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, deleted: true });
      expect(await prisma().webhook.count()).toBe(0);

      const again = await deleteWebhook('hookowner', id);
      expect(again.status).toBe(404);
    });

    it('refuses to delete another user’s webhook', async () => {
      const created = await createWebhook('hookowner', 'https://merchant.example/hooks/private');
      const id = created.body.webhook.id;

      const res = await deleteWebhook('hookother', id);

      expect(res.status).toBe(404);
      // The row is still there: the delete is scoped by username, not just id.
      expect(await prisma().webhook.count()).toBe(1);
    });

    it('removes the webhook when its user is soft-deleted (cascade)', async () => {
      const created = await createWebhook('hookowner', 'https://merchant.example/hooks/gone');
      expect(created.status).toBe(201);
      expect(await prisma().webhook.count()).toBe(1);

      await prisma().user.update({
        where: { username: nameTag('hookowner') },
        data: { deletedAt: new Date() },
      });
      await prisma().user.delete({ where: { username: nameTag('hookowner') } });

      // `onDelete: Cascade` on Webhook.user is a database guarantee, so it holds
      // even for a path the API does not expose.
      expect(await prisma().webhook.count()).toBe(0);
    });

    it('answers 405 for a method the router does not implement', async () => {
      const res = await request(app).put(WEBHOOKS_URL).send(credentialsFor('hookowner'));

      expect(res.status).toBe(405);
    });
  });

  describe('POST /webhooks/verify-test', () => {
    const secret = 'a'.repeat(64);
    const payload = { event: 'payment.completed', amount: 12.5 };

    const legacySignature = (body) =>
      crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

    it('accepts a signature computed over the payload', async () => {
      const res = await request(app)
        .post(VERIFY_URL)
        .send({ secret, payload })
        .set('X-Webhook-Signature', legacySignature(payload));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, valid: true });
    });

    it('rejects a signature computed with the wrong secret', async () => {
      const wrong = crypto.createHmac('sha256', 'b'.repeat(64)).update(JSON.stringify(payload)).digest('hex');

      const res = await request(app)
        .post(VERIFY_URL)
        .send({ secret, payload })
        .set('X-Webhook-Signature', wrong);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false, valid: false, error: { code: 'INVALID_WEBHOOK_SIGNATURE' } });
    });

    it('rejects a payload mutated after signing', async () => {
      const signature = legacySignature(payload);

      const res = await request(app)
        .post(VERIFY_URL)
        .send({ secret, payload: { ...payload, amount: 1000000 } })
        .set('X-Webhook-Signature', signature);

      expect(res.status).toBe(401);
    });

    it('answers 400 when the secret or the signature is missing', async () => {
      const noSecret = await request(app)
        .post(VERIFY_URL)
        .send({ payload })
        .set('X-Webhook-Signature', legacySignature(payload));
      expect(noSecret.status).toBe(400);
      expect(noSecret.body.error.code).toBe('MISSING_WEBHOOK_SECRET');

      const noSignature = await request(app).post(VERIFY_URL).send({ secret, payload });
      expect(noSignature.status).toBe(400);
      expect(noSignature.body.error.code).toBe('MISSING_SIGNATURE');
    });

    describe('timestamp-bound scheme', () => {
      const boundSignature = (timestamp, body) =>
        crypto
          .createHmac('sha256', secret)
          .update(`${timestamp}.${JSON.stringify(body)}`)
          .digest('hex');

      it('accepts a fresh timestamp', async () => {
        const timestamp = new Date().toISOString();

        const res = await request(app)
          .post(VERIFY_URL)
          .send({ secret, payload })
          .set('Stellar-Timestamp', timestamp)
          .set('Stellar-Signature', boundSignature(timestamp, payload));

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
      });

      it('rejects a replayed dispatch older than the tolerance window', async () => {
        const timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();

        const res = await request(app)
          .post(VERIFY_URL)
          .send({ secret, payload })
          .set('Stellar-Timestamp', timestamp)
          .set('Stellar-Signature', boundSignature(timestamp, payload));

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('TIMESTAMP_EXPIRED');
      });

      it('rejects a timestamp more than a minute in the future', async () => {
        const timestamp = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        const res = await request(app)
          .post(VERIFY_URL)
          .send({ secret, payload })
          .set('Stellar-Timestamp', timestamp)
          .set('Stellar-Signature', boundSignature(timestamp, payload));

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('TIMESTAMP_TOO_FAR_IN_FUTURE');
      });

      it('requires the timestamp when the signature is bound to it', async () => {
        const res = await request(app)
          .post(VERIFY_URL)
          .send({ secret, payload })
          .set('Stellar-Signature', boundSignature('2026-01-01T00:00:00.000Z', payload));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('MISSING_TIMESTAMP');
      });
    });
  });
});

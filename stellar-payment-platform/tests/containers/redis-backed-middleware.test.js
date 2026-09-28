'use strict';

/**
 * #686 — the Redis-backed middlewares against a real Redis.
 *
 * Rate limiting and idempotency both keep an in-memory `Map` fallback, so a
 * suite that only ever sees the fallback proves nothing about the code that runs
 * in production. Here Redis is real, and the interesting behaviour — the atomic
 * sliding-window Lua script, the per-IP keying, the shared quota across
 * requests that differ in payload, and the 24h idempotency record — is asserted
 * against the keyspace the server actually writes.
 *
 * `SIGNATURE_RATE_LIMIT_MAX` is lowered before `server.js` is required so the
 * 429 path is reachable in a handful of requests. babel-plugin-jest-hoist lifts
 * the `jest.mock` calls above this assignment, but it does not touch the
 * `require` calls below it, so the limiter still reads the lowered value.
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

process.env.SIGNATURE_RATE_LIMIT_MAX = '3';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { app } = require('../../server');
const { createSlidingWindowRateLimiter } = require('../../src/middleware/slidingWindowRateLimit');
const {
  closeRedis,
  makeAddress,
  prisma,
  redis,
  resetTestState,
  waitForDependencies,
} = require('./support/harness');

const ROOT_REGISTER_URL = '/register';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

/** Every key in the keyspace matching `prefix`, via SCAN (never KEYS). */
async function keysWithPrefix(prefix) {
  const client = await redis();
  const found = [];
  for await (const key of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
    found.push(key);
  }
  return found.sort();
}

describe('Redis-backed middleware (real Redis)', () => {
  beforeAll(async () => {
    await waitForDependencies(app);
  });

  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await closeRedis();
  });

  it('reports both dependencies as up', async () => {
    const res = await request(app).get('/health');

    // Horizon is unreachable from CI and deliberately stubbed elsewhere, so only
    // the two dependencies this phase owns are asserted.
    expect(res.body).toMatchObject({ database: 'up', redis: 'up' });
  });

  describe('signature rate limiter', () => {
    it('counts every POST /register against one per-IP quota', async () => {
      const statuses = [];
      for (let index = 0; index < 3; index += 1) {
        // A different address per request, so the global limiter (keyed by body
        // address) cannot be what rejects the fourth one.
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app)
          .post(ROOT_REGISTER_URL)
          .send({ username: `ratelimit${index}`, address: makeAddress(`RL${index}`) });
        statuses.push(res.status);
        expect(res.headers['ratelimit-limit']).toBe('3');
      }
      expect(statuses).toEqual([201, 201, 201]);

      const blocked = await request(app)
        .post(ROOT_REGISTER_URL)
        .send({ username: 'ratelimit3', address: makeAddress('RL3') });

      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
      expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
      expect(blocked.headers['ratelimit-remaining']).toBe('0');

      // The limiter runs ahead of the handler, so the rejected request never
      // reached the database.
      expect(await prisma().user.count()).toBe(3);
    });

    it('keeps the sliding window in a sorted set in Redis', async () => {
      for (let index = 0; index < 2; index += 1) {
        // eslint-disable-next-line no-await-in-loop
        await request(app)
          .post(ROOT_REGISTER_URL)
          .send({ username: `zset${index}`, address: makeAddress(`ZS${index}`) });
      }

      const client = await redis();
      const keys = await keysWithPrefix('sig-rl:');
      expect(keys).toHaveLength(1);

      const entries = await client.zRange(keys[0], 0, -1, { WITHSCORES: true });
      expect(entries).toHaveLength(2);
      // The window is 60s, so PEXPIRE must have been set by the Lua script.
      const ttl = await client.pTTL(keys[0]);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });
  });

  describe('idempotency', () => {
    const registerWithKey = (key, username) =>
      request(app)
        .post(ROOT_REGISTER_URL)
        .set('Idempotency-Key', key)
        .send({ username, address: makeAddress('IDEM') });

    it('replays a cached response instead of registering twice', async () => {
      const address = makeAddress('REPLAY');
      const first = await request(app)
        .post(ROOT_REGISTER_URL)
        .set('Idempotency-Key', 'retry-me')
        .send({ username: 'replayed', address });

      expect(first.status).toBe(201);
      expect(first.headers['x-idempotent-replay']).toBeUndefined();
      expect(first.body).toMatchObject({ username: 'replayed*localhost', address });

      const second = await request(app)
        .post(ROOT_REGISTER_URL)
        .set('Idempotency-Key', 'retry-me')
        .send({ username: 'replayed', address });

      expect(second.status).toBe(201);
      expect(second.headers['x-idempotent-replay']).toBe('true');
      expect(second.body).toEqual(first.body);

      // One row, not two: the replay never reached the handler.
      expect(await prisma().user.count({ where: { address } })).toBe(1);
    });

    it('stores the record in Redis under a hashed, path-scoped key', async () => {
      await registerWithKey('hashed-key', 'hashed');

      const client = await redis();
      const keys = await keysWithPrefix('idempotency:');
      expect(keys).toHaveLength(1);

      const digest = crypto.createHash('sha256').update('hashed-key').digest('hex');
      expect(keys[0]).toBe(`idempotency:POST:${ROOT_REGISTER_URL}:${digest}`);

      // 24h retention, so a retried payment is protected for a day.
      const ttl = await client.ttl(keys[0]);
      expect(ttl).toBeGreaterThan(86_000);
      expect(ttl).toBeLessThanOrEqual(86_400);

      const cached = JSON.parse(await client.get(keys[0]));
      expect(cached.status).toBe(201);
      expect(cached.body).toMatchObject({ username: 'hashed*localhost' });
    });

    it('does not replay a failed response', async () => {
      const key = 'failure-key';

      // A two-character username fails the schema check, so the handler answers
      // 422 — and the middleware only caches 2xx responses.
      const first = await request(app)
        .post(ROOT_REGISTER_URL)
        .set('Idempotency-Key', key)
        .send({ username: 'ab', address: makeAddress('SHORT') });
      expect(first.status).toBe(422);

      const second = await request(app)
        .post(ROOT_REGISTER_URL)
        .set('Idempotency-Key', key)
        .send({ username: 'ab', address: makeAddress('SHORT') });
      expect(second.status).toBe(422);
      expect(second.headers['x-idempotent-replay']).toBeUndefined();

      const client = await redis();
      expect(await keysWithPrefix('idempotency:')).toEqual([]);
    });

    it('scopes the record to the method and path that created it', async () => {
      await registerWithKey('shared-key', 'scoped');

      // Same key, different endpoint: must not be served from the register
      // route's cache entry.
      const admin = await request(app)
        .post('/api/v1/admin/block')
        .set('Idempotency-Key', 'shared-key')
        .set('x-api-key', ADMIN_API_KEY)
        .send({ address: makeAddress('SCOPED') });

      expect(admin.status).toBe(404); // no such address — and definitely not a replay
      expect(admin.headers['x-idempotent-replay']).toBeUndefined();
    });

    it('ignores the middleware for read-only methods', async () => {
      const res = await request(app).get('/api/v1/users').set('Idempotency-Key', 'read-only');

      expect(res.status).toBe(200);

      const client = await redis();
      expect(await keysWithPrefix('idempotency:')).toEqual([]);
    });
  });

  describe('sliding window against a controlled clock', () => {
    const WINDOW_MS = 60_000;
    const MAX = 2;

    let clock;

    beforeEach(() => {
      clock = Date.parse('2026-03-01T12:00:00.000Z');
    });

    /** A minimal app wearing the real limiter, bound to the real Redis client. */
    const buildRedisProbe = async () => {
      const client = await redis();
      const limiter = createSlidingWindowRateLimiter({
        redisClient: client,
        windowMs: WINDOW_MS,
        max: MAX,
        prefix: 'probe-rl:',
        keyGenerator: (req) => req.get('X-Probe-Id') || 'anon',
        message: { error: 'probe limit reached' },
        now: () => clock,
      });
      const scoped = express();
      scoped.get(
        '/probe',
        (req, res, next) => limiter(req, res, next),
        (req, res) => res.json({ ok: true }),
      );
      return scoped;
    };

    it('blocks the request that exceeds max, and lets it through once the window slides', async () => {
      const scoped = await buildRedisProbe();
      const probe = (id) => request(scoped).get('/probe').set('X-Probe-Id', id);

      expect((await probe('a')).status).toBe(200);
      expect((await probe('a')).status).toBe(200);

      const blocked = await probe('a');
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ error: 'probe limit reached' });
      expect(blocked.headers['ratelimit-remaining']).toBe('0');
      expect(blocked.headers['ratelimit-limit']).toBe(String(MAX));

      // A different identity has its own window.
      expect((await probe('b')).status).toBe(200);

      // The key is a sorted set holding one member per allowed request, scored
      // with the injected clock — never an in-process array.
      const client = await redis();
      const keys = await keysWithPrefix('probe-rl:');
      expect(keys).toEqual(['probe-rl:a']);
      expect(await client.zCard('probe-rl:a')).toBe(MAX);
      const scores = (await client.zRange('probe-rl:a', 0, -1, { WITHSCORES: true })).filter((_, i) => i % 2 === 1);
      for (const score of scores) {
        expect(Number(score)).toBe(clock);
      }

      // Slide past the window: the two old entries fall out of it.
      clock += WINDOW_MS + 1;
      expect((await probe('a')).status).toBe(200);
      expect(await client.zCard('probe-rl:a')).toBe(1);
    });

    it('counts a burst on a shared identity, not per request', async () => {
      const scoped = await buildRedisProbe();

      const results = await Promise.all(
        Array.from({ length: 6 }, () => request(scoped).get('/probe').set('X-Probe-Id', 'burst')),
      );

      // The Lua script is a single atomic compare-and-add, so exactly MAX of the
      // concurrent requests may pass. An in-memory store without the atomic step
      // would let the whole burst through.
      expect(results.filter((res) => res.status === 200)).toHaveLength(MAX);
      expect(results.filter((res) => res.status === 429)).toHaveLength(6 - MAX);
    });

    it('falls back to a process-local window when Redis is unreachable', async () => {
      const limiter = createSlidingWindowRateLimiter({
        redisClient: { isReady: true, eval: async () => { throw new Error('ECONNREFUSED'); } },
        windowMs: WINDOW_MS,
        max: 1,
        prefix: 'degraded-rl:',
        keyGenerator: (req) => req.get('X-Probe-Id') || 'anon',
        message: { error: 'probe limit reached' },
        now: () => clock,
      });
      const degraded = express();
      degraded.get('/probe', (req, res, next) => limiter(req, res, next), (req, res) => res.json({ ok: true }));

      expect((await request(degraded).get('/probe')).status).toBe(200);
      expect((await request(degraded).get('/probe')).status).toBe(429);
    });
  });
});

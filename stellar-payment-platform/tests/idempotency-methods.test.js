'use strict';

const express = require('express');
const request = require('supertest');
const { idempotencyMiddleware, IDEMPOTENCY_HEADER } = require('../middleware/idempotency');

// The in-memory fallback path is exercised by passing a null/falsey redisClient.
const buildApp = (method, path, handler) => {
  const app = express();
  app.use(express.json());
  app.use(idempotencyMiddleware(null));
  app[method.toLowerCase()](path, handler);
  return app;
};

describe('idempotency middleware — mutating methods', () => {
  test('allows an optional key to be omitted', async () => {
    let calls = 0;
    const app = buildApp('post', '/things', (_req, res) => res.status(201).json({ calls: ++calls }));

    expect((await request(app).post('/things').send({})).body.calls).toBe(1);
    expect((await request(app).post('/things').send({})).body.calls).toBe(2);
  });

  test('caches and replays a successful POST response for duplicate keys', async () => {
    let calls = 0;
    const handler = (req, res) => {
      calls += 1;
      res.status(201).json({ created: calls });
    };
    const app = buildApp('post', '/things', handler);

    const first = await request(app)
      .post('/things')
      .set(IDEMPOTENCY_HEADER, 'key-1')
      .send({});
    const second = await request(app)
      .post('/things')
      .set(IDEMPOTENCY_HEADER, 'key-1')
      .send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    // The handler must only run once — the duplicate is served from cache.
    expect(calls).toBe(1);
  });

  test('caches and replays a successful DELETE response for duplicate keys', async () => {
    let calls = 0;
    const handler = (req, res) => {
      calls += 1;
      res.status(200).json({ deleted: true });
    };
    const app = buildApp('delete', '/things/:id', handler);

    const first = await request(app)
      .delete('/things/42')
      .set(IDEMPOTENCY_HEADER, 'del-key');
    const second = await request(app)
      .delete('/things/42')
      .set(IDEMPOTENCY_HEADER, 'del-key');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(calls).toBe(1);
  });

  test('does not replay for read-only GET requests', async () => {
    let calls = 0;
    const handler = (req, res) => {
      calls += 1;
      res.status(200).json({ n: calls });
    };
    const app = buildApp('get', '/things', handler);

    const first = await request(app).get('/things').set(IDEMPOTENCY_HEADER, 'get-key');
    const second = await request(app).get('/things').set(IDEMPOTENCY_HEADER, 'get-key');

    expect(first.body).not.toEqual(second.body);
    expect(second.headers['x-idempotent-replay']).toBeUndefined();
    expect(calls).toBe(2);
  });

  test('different keys are treated as distinct requests', async () => {
    let calls = 0;
    const handler = (req, res) => {
      calls += 1;
      res.status(201).json({ created: calls });
    };
    const app = buildApp('post', '/things', handler);

    await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'a').send({});
    await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'b').send({});

    expect(calls).toBe(2);
  });

  test('rejects overly long idempotency keys', async () => {
    const handler = (req, res) => res.status(201).json({ ok: true });
    const app = buildApp('post', '/things', handler);

    const res = await request(app)
      .post('/things')
      .set(IDEMPOTENCY_HEADER, 'x'.repeat(200))
      .send({});

    expect(res.status).toBe(400);
  });

  test('rejects the same key with a different payment body', async () => {
    let calls = 0;
    const app = buildApp('post', '/payments', (_req, res) => {
      calls += 1;
      res.status(201).json({ accepted: true });
    });

    const first = await request(app).post('/payments').set(IDEMPOTENCY_HEADER, 'shared').send({ amount: 10 });
    const second = await request(app).post('/payments').set(IDEMPOTENCY_HEADER, 'shared').send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.headers['x-idempotent-replay']).toBeUndefined();
    expect(calls).toBe(1);
  });

  test('does not replay a response across API keys', async () => {
    let calls = 0;
    const app = buildApp('post', '/payments', (_req, res) => {
      calls += 1;
      res.status(201).json({ accepted: true });
    });

    await request(app).post('/payments').set(IDEMPOTENCY_HEADER, 'shared').set('x-api-key', 'owner-a').send({ amount: 10 });
    const other = await request(app).post('/payments').set(IDEMPOTENCY_HEADER, 'shared').set('x-api-key', 'owner-b').send({ amount: 10 });

    expect(other.status).toBe(409);
    expect(calls).toBe(1);
  });

  test('admits only one simultaneous request for a key', async () => {
    let release;
    let started;
    const entered = new Promise((resolve) => { started = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const app = buildApp('post', '/payments', async (_req, res) => {
      calls += 1;
      started();
      await blocked;
      res.status(201).json({ accepted: true });
    });

    const firstPromise = request(app).post('/payments').set(IDEMPOTENCY_HEADER, 'race').send({ amount: 10 });
    const first = firstPromise.then((response) => response);
    await entered;
    const concurrent = await request(app).post('/payments').set(IDEMPOTENCY_HEADER, 'race').send({ amount: 10 });
    expect(concurrent.status).toBe(409);
    release();
    expect((await first).status).toBe(201);

    const replay = await request(app).post('/payments').set(IDEMPOTENCY_HEADER, 'race').send({ amount: 10 });
    expect(replay.status).toBe(201);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(calls).toBe(1);
  });

  test('releases a key after a failed response', async () => {
    let calls = 0;
    const app = buildApp('post', '/payments', (_req, res) => {
      calls += 1;
      res.status(calls === 1 ? 500 : 201).json({ calls });
    });

    const first = await request(app).post('/payments').set(IDEMPOTENCY_HEADER, 'retry').send({ amount: 10 });
    const retry = await request(app).post('/payments').set(IDEMPOTENCY_HEADER, 'retry').send({ amount: 10 });
    expect(first.status).toBe(500);
    expect(retry.status).toBe(201);
    expect(calls).toBe(2);
  });

  test('fails closed when configured Redis is unavailable', async () => {
    let calls = 0;
    const app = express();
    app.use(express.json());
    app.use(idempotencyMiddleware({ isReady: false }));
    app.post('/payments', (_req, res) => { calls += 1; res.status(201).json({ accepted: true }); });

    const response = await request(app).post('/payments').set(IDEMPOTENCY_HEADER, 'redis-down').send({ amount: 10 });
    expect(response.status).toBe(503);
    expect(calls).toBe(0);
  });

  test('bounds the local cache and reclaims expired entries', async () => {
    const app = buildApp('post', '/things', (_req, res) => res.status(201).json({ ok: true }));
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    try {
      for (let index = 0; index < 1000; index += 1) {
        expect((await request(app).post('/things').set(IDEMPOTENCY_HEADER, `key-${index}`).send({})).status).toBe(201);
      }

      expect((await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'overflow').send({})).status).toBe(503);
      clock.mockReturnValue(now + 24 * 60 * 60 * 1000 + 1);
      expect((await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'after-expiry').send({})).status).toBe(201);
    } finally {
      clock.mockRestore();
    }
  }, 30000);

  test('an expired claim cannot overwrite a newer response', async () => {
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const app = buildApp('post', '/things', async (_req, res) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await blocked;
      }
      res.status(201).json({ calls });
    });
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    try {
      const first = request(app).post('/things').set(IDEMPOTENCY_HEADER, 'expired').send({});
      const firstResult = first.then((response) => response);
      await started;
      clock.mockReturnValue(now + 5 * 60 * 1000 + 1);
      expect((await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'expired').send({})).body.calls).toBe(2);
      release();
      expect((await firstResult).status).toBe(503);
      expect((await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'expired').send({})).body.calls).toBe(2);
      expect(calls).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  test('a failed expired request cannot release a newer reservation', async () => {
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const app = buildApp('post', '/things', async (_req, res) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await blocked;
        return res.status(500).json({ calls: 1 });
      }
      return res.status(201).json({ calls: 2 });
    });
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    try {
      const first = request(app).post('/things').set(IDEMPOTENCY_HEADER, 'expired-failure').send({});
      const firstResult = first.then((response) => response);
      await started;
      clock.mockReturnValue(now + 5 * 60 * 1000 + 1);
      expect((await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'expired-failure').send({})).status).toBe(201);
      release();
      expect((await firstResult).status).toBe(500);
      const replay = await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'expired-failure').send({});
      expect(replay.headers['x-idempotent-replay']).toBe('true');
      expect(replay.body.calls).toBe(2);
      expect(calls).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  test('releases a reservation when the request disconnects', async () => {
    let calls = 0;
    const app = buildApp('post', '/things', (_req, res) => {
      calls += 1;
      if (calls === 1) res.destroy();
      else res.status(201).json({ calls });
    });

    await expect(request(app).post('/things').set(IDEMPOTENCY_HEADER, 'disconnect').send({})).rejects.toThrow();
    const retry = await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'disconnect').send({});
    expect(retry.status).toBe(201);
    expect(calls).toBe(2);
  });
});

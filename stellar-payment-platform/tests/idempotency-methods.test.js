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
});

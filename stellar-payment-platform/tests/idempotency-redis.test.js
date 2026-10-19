'use strict';

const express = require('express');
const request = require('supertest');
const { idempotencyMiddleware } = require('../middleware/idempotency');
const { logger } = require('../src/logger');

class FakeRedis {
  constructor() {
    this.isReady = true;
    this.records = new Map();
  }

  async set(key, value, options) {
    if (options.NX && this.records.has(key)) return null;
    this.records.set(key, { value, ttl: options.EX });
    return 'OK';
  }

  async get(key) {
    return this.records.get(key)?.value || null;
  }

  async eval(script, { keys, arguments: args }) {
    const current = this.records.get(keys[0]);
    if (!current || current.value !== args[0]) return 0;
    if (script.includes("redis.call('DEL'")) {
      this.records.delete(keys[0]);
      return 1;
    }
    this.records.set(keys[0], { value: args[1], ttl: Number(args[2]) });
    return 'OK';
  }
}

function buildApp(redis) {
  const app = express();
  app.use(express.json());
  app.use(idempotencyMiddleware(redis));
  let calls = 0;
  app.post('/payments', (req, res) => {
    calls += 1;
    res.status(req.body.fail ? 500 : 201).json({ calls });
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(error.statusCode || 500).json({ error: error.code });
  });
  return { app, getCalls: () => calls };
}

test('Redis claim is saved before a response and replayed once', async () => {
  const redis = new FakeRedis();
  const { app, getCalls } = buildApp(redis);
  const send = () => request(app).post('/payments').set('Idempotency-Key', 'one').send({ amount: 10 });

  const first = await send();
  const second = await send();

  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(second.body).toEqual(first.body);
  expect(second.headers['x-idempotent-replay']).toBe('true');
  expect(getCalls()).toBe(1);
  expect([...redis.records.values()][0].ttl).toBe(86400);
});

test('Redis rejects a changed request and releases a failed claim', async () => {
  const redis = new FakeRedis();
  const { app, getCalls } = buildApp(redis);
  const send = (body) => request(app).post('/payments').set('Idempotency-Key', 'one').send(body);

  expect((await send({ fail: true })).status).toBe(500);
  expect(redis.records.size).toBe(0);
  expect((await send({ amount: 10 })).status).toBe(201);
  expect((await send({ amount: 100 })).status).toBe(409);
  expect(getCalls()).toBe(2);
});

test('a disappearing Redis claim fails closed', async () => {
  const redis = new FakeRedis();
  redis.set = async () => null;
  const { app, getCalls } = buildApp(redis);

  const response = await request(app).post('/payments').set('Idempotency-Key', 'one').send({ amount: 10 });
  expect(response.status).toBe(503);
  expect(getCalls()).toBe(0);
});

test('an unknown Redis record cannot be replayed', async () => {
  const redis = new FakeRedis();
  const { app, getCalls } = buildApp(redis);
  const send = () => request(app).post('/payments').set('Idempotency-Key', 'one').send({ amount: 10 });
  await send();
  const [key, saved] = [...redis.records][0];
  redis.records.set(key, { ...saved, value: JSON.stringify({ ...JSON.parse(saved.value), state: 'unknown' }) });

  expect((await send()).status).toBe(503);
  expect(getCalls()).toBe(1);
});

test('a Redis record without a saved content type still replays', async () => {
  const redis = new FakeRedis();
  const { app, getCalls } = buildApp(redis);
  const send = () => request(app).post('/payments').set('Idempotency-Key', 'one').send({ amount: 10 });
  await send();
  const [key, saved] = [...redis.records][0];
  const record = JSON.parse(saved.value);
  delete record.contentType;
  redis.records.set(key, { ...saved, value: JSON.stringify(record) });

  expect((await send()).status).toBe(201);
  expect(getCalls()).toBe(1);
});

test('a lost claim prevents a success response', async () => {
  const redis = new FakeRedis();
  redis.eval = async () => 0;
  const { app, getCalls } = buildApp(redis);

  const response = await request(app).post('/payments').set('Idempotency-Key', 'one').send({ amount: 10 });
  expect(response.status).toBe(503);
  expect(getCalls()).toBe(1);
});

test('a release error does not hide the failed handler response', async () => {
  const redis = new FakeRedis();
  redis.eval = async () => { throw new Error('Redis failed'); };
  const { app } = buildApp(redis);

  const response = await request(app).post('/payments').set('Idempotency-Key', 'one').send({ fail: true });
  expect(response.status).toBe(500);
});

test('logs a release error after a client disconnects', async () => {
  const redis = new FakeRedis();
  redis.eval = async () => { throw new Error('Redis failed'); };
  const log = jest.spyOn(logger, 'error').mockImplementation(() => {});
  const app = express();
  app.use(express.json());
  app.use(idempotencyMiddleware(redis));
  app.post('/payments', (_req, res) => res.destroy());

  try {
    await expect(request(app).post('/payments').set('Idempotency-Key', 'one').send({ amount: 10 })).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toHaveBeenCalledWith('Failed to release idempotency key:', expect.any(Error));
  } finally {
    log.mockRestore();
  }
});

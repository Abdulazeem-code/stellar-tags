'use strict';

const express = require('express');
const request = require('supertest');

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock('../../src/logger', () => ({ logger: mockLogger }));

const { bodySizeLimit } = require('../../src/middleware/bodyLimit');
const { buildErrorHandler } = require('../../src/middleware/errorHandler');

const buildApp = (path, handler) => {
  const app = express();
  app.use((req, res, next) => {
    req.correlationId = 'test-correlation-id';
    next();
  });
  // #588 — same wiring server.js uses: per-route limit, then the terminal 413
  // handler that turns body-parser's entity.too.large into the envelope.
  app.use(bodySizeLimit);
  app.post(path, handler || ((req, res) => res.json({ ok: true, bytes: JSON.stringify(req.body).length })));
  app.use(buildErrorHandler(() => false));
  return app;
};

// A payload just over a given kb ceiling.
const over = (kb) => 'x'.repeat(kb * 1024 + 1);
const under = (kb) => 'x'.repeat(kb * 1024);

describe('body size limits (#588)', () => {
  test('auth endpoint rejects payloads over 1kb with 413', async () => {
    const res = await request(buildApp('/register'))
      .post('/register')
      .set('Content-Type', 'application/json')
      .send(over(1));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body.error.message).toMatch(/1kb/);
  });

  test('auth endpoint accepts payloads within 1kb', async () => {
    const res = await request(buildApp('/register'))
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ username: 'alice', address: 'GABCDEFGHIJKLMNOP' });
    expect(res.status).toBeLessThan(400);
  });

  test('bulk /payments endpoint accepts payloads up to 100kb', async () => {
    const res = await request(buildApp('/api/v1/payments/bulk'))
      .post('/api/v1/payments/bulk')
      .set('Content-Type', 'application/json')
      .send({ intents: under(50) });
    expect(res.status).toBeLessThan(400);
  });

  test('bulk /payments endpoint rejects payloads over 100kb', async () => {
    const res = await request(buildApp('/api/v1/payments/bulk'))
      .post('/api/v1/payments/bulk')
      .set('Content-Type', 'application/json')
      .send({ intents: over(100) });
    expect(res.status).toBe(413);
    expect(res.body.error.message).toMatch(/100kb/);
  });

  test('bulk /webhooks endpoint accepts up to 100kb and rejects over', async () => {
    const ok = await request(buildApp('/api/v1/webhooks'))
      .post('/api/v1/webhooks')
      .set('Content-Type', 'application/json')
      .send({ url: 'https://example.com', username: under(50) });
    expect(ok.status).toBeLessThan(400);

    const res = await request(buildApp('/api/v1/webhooks'))
      .post('/api/v1/webhooks')
      .set('Content-Type', 'application/json')
      .send({ url: 'https://example.com', username: over(100) });
    expect(res.status).toBe(413);
    expect(res.body.error.message).toMatch(/100kb/);
  });

  test('standard endpoints reject payloads over 10kb', async () => {
    const res = await request(buildApp('/api/v1/users'))
      .post('/api/v1/users')
      .set('Content-Type', 'application/json')
      .send({ data: over(10) });
    expect(res.status).toBe(413);
    expect(res.body.error.message).toMatch(/10kb/);
  });

  test('standard endpoints accept payloads within 10kb', async () => {
    const res = await request(buildApp('/api/v1/users'))
      .post('/api/v1/users')
      .set('Content-Type', 'application/json')
      .send({ data: under(5) });
    expect(res.status).toBeLessThan(400);
  });

  test('non-JSON bodies are not parsed or limited', async () => {
    const res = await request(buildApp('/api/v1/users'))
      .post('/api/v1/users')
      .set('Content-Type', 'text/plain')
      .send(over(1000));
    expect(res.status).not.toBe(413);
  });
});

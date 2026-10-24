'use strict';

/**
 * #730 — Server-Sent Events for payment status updates.
 *
 * Covers the SSE manager (client registry, broadcast, Redis fan-out,
 * shutdown) and the `GET /payments/:paymentId/events` stream route, including
 * the pieces Socket.io used to own: room-style subscription, cross-process
 * delivery and draining open connections during shutdown.
 */

// Small heartbeat so the keep-alive path is observable inside a test run.
process.env.SSE_HEARTBEAT_MS = '100';
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    payment: { findUnique: jest.fn() },
    paymentIntent: { findUnique: jest.fn() },
  },
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

jest.mock('../src/config/redis', () => {
  const EventEmitter = require('events');
  const subscriber = new EventEmitter();
  subscriber.subscribe = jest.fn((channel, cb) => cb && cb(null));
  subscriber.quit = jest.fn().mockResolvedValue(undefined);
  return {
    createRedisConnection: jest.fn(() => subscriber),
    isClusterMode: jest.fn(() => false),
  };
});

const http = require('http');
const express = require('express');
const request = require('supertest');

const { prisma } = require('../prismaClient');
const { createRedisConnection } = require('../src/config/redis');
const {
  initSse,
  closeSse,
  emitPaymentUpdate,
  publishPaymentUpdate,
  getSseClientCount,
  isSseStreamPath,
  REDIS_CHANNEL,
} = require('../src/sse');
const sseRoutes = require('../src/routes/v1/sseRoutes');

const createApp = () => {
  const app = express();
  app.use('/api/v1', sseRoutes(null)); // null redis → limiter passes through
  return app;
};

const app = createApp();

/** Parse one SSE block ("event: x\ndata: y") into a message object. */
const parseBlock = (block) => {
  const message = { event: null, data: null, retry: null, comment: null };
  for (const line of block.split('\n')) {
    if (line.startsWith('retry: ')) message.retry = Number(line.slice(7));
    else if (line.startsWith('event: ')) message.event = line.slice(7);
    else if (line.startsWith('data: ')) {
      const raw = line.slice(6);
      try {
        message.data = JSON.parse(raw);
      } catch {
        message.data = raw;
      }
    } else if (line.startsWith(': ')) message.comment = line.slice(2);
  }
  return message;
};

/** Open a live SSE connection and expose helpers to observe it. */
const openStream = (path) =>
  new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: serverPort, path },
      (res) => {
        const state = {
          res,
          messages: [],
          ended: false,
          raw: '',
          waitFor(predicate, timeoutMs = 3000) {
            return new Promise((waitResolve, waitReject) => {
              const startedAt = Date.now();
              const check = () => {
                const found = state.messages.find(predicate);
                if (found) return waitResolve(found);
                if (Date.now() - startedAt > timeoutMs) {
                  return waitReject(
                    new Error(
                      `Timed out waiting for message. Received: ${JSON.stringify(state.messages)}`,
                    ),
                  );
                }
                setTimeout(check, 10);
              };
              check();
            });
          },
          close() {
            req.destroy();
          },
        };

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          state.raw += chunk;
          let separator = state.raw.indexOf('\n\n');
          while (separator !== -1) {
            state.messages.push(parseBlock(state.raw.slice(0, separator)));
            state.raw = state.raw.slice(separator + 2);
            separator = state.raw.indexOf('\n\n');
          }
        });
        res.on('end', () => {
          state.ended = true;
        });
        res.on('close', () => {
          state.ended = true;
        });
        resolve(state);
      },
    );
    req.on('error', reject);
  });

let server;
let serverPort;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = server.address().port;
});

afterAll(async () => {
  await closeSse();
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /payments/:paymentId/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.payment.findUnique.mockResolvedValue(null);
    prisma.paymentIntent.findUnique.mockResolvedValue(null);
  });

  it('opens a text/event-stream with retry hint and connected event', async () => {
    const stream = await openStream('/api/v1/payments/PAY-1/events');

    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers['content-type']).toContain('text/event-stream');
    // Signals no caching and opts out of compression/proxy buffering.
    expect(stream.res.headers['cache-control']).toContain('no-transform');
    expect(stream.res.headers['x-accel-buffering']).toBe('no');

    const retry = await stream.waitFor((m) => m.retry !== null);
    expect(retry.retry).toBeGreaterThan(0);

    const connected = await stream.waitFor((m) => m.event === 'connected');
    expect(connected.data).toEqual({ paymentId: 'PAY-1' });

    expect(getSseClientCount()).toBe(1);
    stream.close();
    await closeSse();
  });

  it('rejects a malformed paymentId with 400', async () => {
    const res = await request(app).get('/api/v1/payments/bad$id!events/events');
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(getSseClientCount()).toBe(0);
  });

  it('rejects an over-long paymentId with 400', async () => {
    const res = await request(app).get(`/api/v1/payments/${'a'.repeat(129)}/events`);
    expect(res.statusCode).toBe(400);
  });

  it('sends a payment snapshot after connecting', async () => {
    prisma.payment.findUnique.mockResolvedValue({
      id: 'PAY-2',
      status: 'completed',
      transactionHash: 'deadbeef',
    });

    const stream = await openStream('/api/v1/payments/PAY-2/events');
    const snapshot = await stream.waitFor((m) => m.event === 'snapshot');

    expect(snapshot.data).toEqual({
      paymentId: 'PAY-2',
      status: 'completed',
      transactionHash: 'deadbeef',
    });
    expect(prisma.paymentIntent.findUnique).not.toHaveBeenCalled();

    stream.close();
    await closeSse();
  });

  it('falls back to the payment intent for the snapshot', async () => {
    prisma.payment.findUnique.mockResolvedValue(null);
    prisma.paymentIntent.findUnique.mockResolvedValue({
      id: 'INT-1',
      status: 'pending',
    });

    const stream = await openStream('/api/v1/payments/INT-1/events');
    const snapshot = await stream.waitFor((m) => m.event === 'snapshot');

    expect(snapshot.data).toEqual({
      paymentId: 'INT-1',
      status: 'pending',
    });

    stream.close();
    await closeSse();
  });

  it('streams without a snapshot when the payment does not exist yet', async () => {
    const stream = await openStream('/api/v1/payments/UNKNOWN/events');
    await stream.waitFor((m) => m.event === 'connected');
    // Give the snapshot query time to come back empty.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stream.messages.some((m) => m.event === 'snapshot')).toBe(false);
    expect(stream.res.statusCode).toBe(200);

    stream.close();
    await closeSse();
  });

  it('drops a stale snapshot when a live update lands first', async () => {
    let releaseSnapshot;
    prisma.payment.findUnique.mockReturnValue(
      new Promise((resolve) => {
        releaseSnapshot = resolve;
      }),
    );

    const stream = await openStream('/api/v1/payments/PAY-3/events');
    await stream.waitFor((m) => m.event === 'connected');

    emitPaymentUpdate('PAY-3', { status: 'completed' });
    await stream.waitFor((m) => m.event === 'payment-update');

    releaseSnapshot({ id: 'PAY-3', status: 'pending', transactionHash: null });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stream.messages.some((m) => m.event === 'snapshot')).toBe(false);

    stream.close();
    await closeSse();
  });

  it('streams keep-alive comments so proxies do not idle-timeout', async () => {
    const stream = await openStream('/api/v1/payments/PAY-4/events');
    const heartbeat = await stream.waitFor(
      (m) => m.comment === 'keep-alive',
      2000,
    );
    expect(heartbeat.comment).toBe('keep-alive');

    stream.close();
    await closeSse();
  });
});

describe('payment-update delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.payment.findUnique.mockResolvedValue(null);
    prisma.paymentIntent.findUnique.mockResolvedValue(null);
  });

  afterEach(async () => {
    await closeSse();
  });

  it('delivers updates only to subscribers of that payment', async () => {
    const target = await openStream('/api/v1/payments/PAY-A/events');
    const bystander = await openStream('/api/v1/payments/PAY-B/events');
    await target.waitFor((m) => m.event === 'connected');
    await bystander.waitFor((m) => m.event === 'connected');

    const delivered = emitPaymentUpdate('PAY-A', {
      status: 'completed',
      transactionHash: 'abc',
    });
    expect(delivered).toBe(1);

    const update = await target.waitFor((m) => m.event === 'payment-update');
    expect(update.data).toEqual({
      paymentId: 'PAY-A',
      status: 'completed',
      transactionHash: 'abc',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bystander.messages.some((m) => m.event === 'payment-update')).toBe(
      false,
    );

    target.close();
    bystander.close();
  });

  it('ignores invalid payment ids and reports zero deliveries', () => {
    expect(emitPaymentUpdate('', { status: 'completed' })).toBe(0);
    expect(emitPaymentUpdate(null, { status: 'completed' })).toBe(0);
    expect(emitPaymentUpdate('NOBODY-LISTENING', { status: 'x' })).toBe(0);
  });

  it('stops tracking a client once it disconnects', async () => {
    const stream = await openStream('/api/v1/payments/PAY-C/events');
    await stream.waitFor((m) => m.event === 'connected');
    expect(getSseClientCount()).toBe(1);

    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getSseClientCount()).toBe(0);
  });
});

describe('cross-process fan-out (Redis)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.payment.findUnique.mockResolvedValue(null);
    prisma.paymentIntent.findUnique.mockResolvedValue(null);
  });

  afterEach(async () => {
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
    await closeSse();
  });

  it('forwards messages published on the payment channel', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    expect(initSse()).toBe(true);
    expect(createRedisConnection).toHaveBeenCalled();

    const stream = await openStream('/api/v1/payments/PAY-R/events');
    await stream.waitFor((m) => m.event === 'connected');

    const subscriber = createRedisConnection.mock.results[0].value;
    subscriber.emit(
      'message',
      REDIS_CHANNEL,
      JSON.stringify({ paymentId: 'PAY-R', status: 'completed' }),
    );

    const update = await stream.waitFor((m) => m.event === 'payment-update');
    expect(update.data).toEqual({ paymentId: 'PAY-R', status: 'completed' });

    stream.close();
  });

  it('accepts the legacy paymentIntentId field from older publishers', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    initSse();

    const stream = await openStream('/api/v1/payments/PAY-L/events');
    await stream.waitFor((m) => m.event === 'connected');

    const subscriber = createRedisConnection.mock.results[0].value;
    subscriber.emit(
      'message',
      REDIS_CHANNEL,
      JSON.stringify({ paymentIntentId: 'PAY-L', status: 'failed' }),
    );

    const update = await stream.waitFor((m) => m.event === 'payment-update');
    expect(update.data).toEqual({ paymentId: 'PAY-L', status: 'failed' });

    stream.close();
  });

  it('skips malformed messages and messages without a payment id', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    initSse();

    const stream = await openStream('/api/v1/payments/PAY-M/events');
    await stream.waitFor((m) => m.event === 'connected');

    const subscriber = createRedisConnection.mock.results[0].value;
    subscriber.emit('message', REDIS_CHANNEL, '{not json');
    subscriber.emit('message', REDIS_CHANNEL, JSON.stringify({ status: 'x' }));
    subscriber.emit('message', 'some:other:channel', JSON.stringify({ paymentId: 'PAY-M' }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stream.messages.some((m) => m.event === 'payment-update')).toBe(
      false,
    );

    stream.close();
  });

  it('publishPaymentUpdate writes to the shared channel', async () => {
    const publisher = { publish: jest.fn().mockResolvedValue(1) };

    await publishPaymentUpdate(publisher, 'PAY-P', { status: 'completed' });

    expect(publisher.publish).toHaveBeenCalledWith(
      REDIS_CHANNEL,
      JSON.stringify({ paymentId: 'PAY-P', status: 'completed' }),
    );
  });

  it('publishPaymentUpdate without a publisher is a no-op', async () => {
    await expect(
      publishPaymentUpdate(null, 'PAY-P', { status: 'completed' }),
    ).resolves.toBeUndefined();
    await expect(
      publishPaymentUpdate({ publish: jest.fn() }, '', {}),
    ).resolves.toBeUndefined();
  });

  it('is not initialized twice in a row', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    expect(initSse()).toBe(true);
    expect(initSse()).toBe(false);
  });
});

describe('shutdown', () => {
  it('closes open streams so the HTTP server can shut down', async () => {
    const stream = await openStream('/api/v1/payments/PAY-S/events');
    await stream.waitFor((m) => m.event === 'connected');
    expect(getSseClientCount()).toBe(1);

    await closeSse();

    expect(getSseClientCount()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stream.ended).toBe(true);
  });

  it('resolves when nothing was ever initialized', async () => {
    await expect(closeSse()).resolves.toBeUndefined();
  });
});

describe('isSseStreamPath', () => {
  it('matches stream paths at any mount depth', () => {
    expect(isSseStreamPath('/payments/abc/events')).toBe(true);
    expect(isSseStreamPath('/api/v1/payments/abc/events')).toBe(true);
    expect(isSseStreamPath('/api/payments/abc/events/')).toBe(true);
  });

  it('does not match other payment or API paths', () => {
    expect(isSseStreamPath('/payments/abc')).toBe(false);
    expect(isSseStreamPath('/payments/bulk')).toBe(false);
    expect(isSseStreamPath('/api/v1/accounts/GABC/payments')).toBe(false);
    expect(isSseStreamPath('/metrics')).toBe(false);
    expect(isSseStreamPath(undefined)).toBe(false);
  });
});

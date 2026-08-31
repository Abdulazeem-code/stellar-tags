'use strict';

const express = require('express');
const request = require('supertest');

const mockUserUpdate = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    user: { update: mockUserUpdate },
  },
  isPrismaConnectionError: () => false,
}));

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

const { idempotencyMiddleware, IDEMPOTENCY_HEADER } = require('../middleware/idempotency');
const buildAdminRouter = require('../src/routes/v1/adminRoutes');

describe('admin block idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserUpdate.mockResolvedValue({
      address: 'GABC',
      username: 'alice*stellar',
      flaggedAt: new Date(),
    });
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/', buildAdminRouter(null));
    return app;
  };

  test('returns cached 2xx response on duplicate block requests', async () => {
    const app = buildApp();

    const first = await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-1')
      .send({ address: 'GABC' });

    const second = await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-1')
      .send({ address: 'GABC' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    // Handler must only run once; the duplicate is served from cache.
    expect(mockUserUpdate).toHaveBeenCalledTimes(1);
  });

  test('distinct keys run the handler again', async () => {
    const app = buildApp();

    await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-a')
      .send({ address: 'GABC' });
    await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-b')
      .send({ address: 'GABC' });

    expect(mockUserUpdate).toHaveBeenCalledTimes(2);
  });

  test('ignores idempotency key on read-only admin GET endpoints', async () => {
    const app = buildApp();

    const first = await request(app)
      .get('/admin/audit-logs')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'audit-key');
    const second = await request(app)
      .get('/admin/audit-logs')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'audit-key');

    expect(first.headers['x-idempotent-replay']).toBeUndefined();
    expect(second.headers['x-idempotent-replay']).toBeUndefined();
  });
});

const crypto = require('crypto');
const request = require('supertest');

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
  Keypair: { fromPublicKey: jest.fn() },
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => null),
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
    webhook: {
      create: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

process.env.NODE_ENV = 'test';

const { app } = require('../server');

describe('POST /api/v1/webhooks/verify-test', () => {
  test('accepts a payload and signature and returns success', async () => {
    const secret = 'test-webhook-secret';
    const payload = { event: 'payment.created', id: 'evt_123', amount: 42 };
    const signature = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

    const res = await request(app)
      .post('/api/v1/webhooks/verify-test')
      .set('X-Webhook-Signature', signature)
      .send({ secret, payload: JSON.stringify(payload) });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.valid).toBe(true);
    expect(res.body.message).toMatch(/succeeded/i);
    expect(res.body.expectedSignature).toBe(signature);
  });

  test('returns detailed failure when the signature does not match', async () => {
    const secret = 'test-webhook-secret';
    const payload = { event: 'payment.created', id: 'evt_123', amount: 42 };

    const res = await request(app)
      .post('/api/v1/webhooks/verify-test')
      .set('X-Webhook-Signature', 'abc123')
      .send({ secret, payload: JSON.stringify(payload) });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_WEBHOOK_SIGNATURE',
    });
    expect(res.body.receivedSignature).toBe('abc123');
  });
});

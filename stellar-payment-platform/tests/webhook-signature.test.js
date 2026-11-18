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

describe('POST /api/v1/webhooks/verify-test (Stellar-Signature)', () => {
  const boundSignature = (secret, timestamp, payloadString) => crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payloadString}`)
    .digest('hex');

  test('accepts a bound Stellar-Signature with a fresh timestamp', async () => {
    const secret = 'test-webhook-secret';
    const timestamp = new Date().toISOString();
    const payload = { event: 'payment.received', id: 'evt_456', amount: 10, timestamp };
    const payloadString = JSON.stringify(payload);
    const signature = boundSignature(secret, timestamp, payloadString);

    const res = await request(app)
      .post('/api/v1/webhooks/verify-test')
      .set('Stellar-Signature', signature)
      .set('Stellar-Timestamp', timestamp)
      .send({ secret, payload: payloadString });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.valid).toBe(true);
  });

  test('rejects timestamps older than 5 minutes', async () => {
    const secret = 'test-webhook-secret';
    const timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const payload = { event: 'payment.received', id: 'evt_old', amount: 10, timestamp };
    const payloadString = JSON.stringify(payload);
    const signature = boundSignature(secret, timestamp, payloadString);

    const res = await request(app)
      .post('/api/v1/webhooks/verify-test')
      .set('Stellar-Signature', signature)
      .set('Stellar-Timestamp', timestamp)
      .send({ secret, payload: payloadString });

    expect(res.status).toBe(401);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatchObject({ code: 'TIMESTAMP_EXPIRED' });
  });

  test('rejects timestamps more than 1 minute in the future', async () => {
    const secret = 'test-webhook-secret';
    const timestamp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const payload = { event: 'payment.received', id: 'evt_future', amount: 10, timestamp };
    const payloadString = JSON.stringify(payload);
    const signature = boundSignature(secret, timestamp, payloadString);

    const res = await request(app)
      .post('/api/v1/webhooks/verify-test')
      .set('Stellar-Signature', signature)
      .set('Stellar-Timestamp', timestamp)
      .send({ secret, payload: payloadString });

    expect(res.status).toBe(401);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatchObject({ code: 'TIMESTAMP_TOO_FAR_IN_FUTURE' });
  });

  test('rejects a tampered Stellar-Timestamp header', async () => {
    const secret = 'test-webhook-secret';
    const signedTimestamp = new Date().toISOString();
    const sentTimestamp = new Date(Date.now() + 30 * 1000).toISOString();
    const payload = { event: 'payment.received', id: 'evt_tamper', amount: 10, timestamp: signedTimestamp };
    const payloadString = JSON.stringify(payload);
    const signature = boundSignature(secret, signedTimestamp, payloadString);

    const res = await request(app)
      .post('/api/v1/webhooks/verify-test')
      .set('Stellar-Signature', signature)
      .set('Stellar-Timestamp', sentTimestamp)
      .send({ secret, payload: payloadString });

    expect(res.status).toBe(401);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  test('requires Stellar-Timestamp when Stellar-Signature is used', async () => {
    const secret = 'test-webhook-secret';
    const timestamp = new Date().toISOString();
    const payload = { event: 'payment.received', id: 'evt_no_ts', amount: 10 };
    const payloadString = JSON.stringify(payload);
    const signature = boundSignature(secret, timestamp, payloadString);

    const res = await request(app)
      .post('/api/v1/webhooks/verify-test')
      .set('Stellar-Signature', signature)
      .send({ secret, payload: payloadString });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'MISSING_TIMESTAMP' });
  });
});

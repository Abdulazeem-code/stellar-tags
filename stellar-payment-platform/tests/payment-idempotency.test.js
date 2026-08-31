'use strict';

const express = require('express');
const request = require('supertest');

const mockPaymentIntentCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    paymentIntent: { create: mockPaymentIntentCreate },
    $transaction: mockTransaction,
  },
}));

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

const { idempotencyMiddleware, IDEMPOTENCY_HEADER } = require('../middleware/idempotency');
const buildPaymentRouter = require('../src/routes/v1/paymentRoutes');

const baseIntent = {
  external_id: 'order-123',
  from: 'GSOURCE',
  to: 'GDESTINATION',
  amount: '25.00',
};

describe('payment intent creation idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPaymentIntentCreate.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'intent-1', externalId: data.externalId, metadata: data.metadata }),
    );
    mockTransaction.mockImplementation((operations) => Promise.all(operations));
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/', buildPaymentRouter(null));
    return app;
  };

  test('deduplicates identical bulk payment submissions', async () => {
    const app = buildApp();

    const payload = [{ ...baseIntent }];
    const first = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'pay-key-1')
      .send(payload);
    const second = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'pay-key-1')
      .send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(1);
  });

  test('distinct keys create separate intents', async () => {
    const app = buildApp();

    await request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'pay-a').send([baseIntent]);
    await request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'pay-b').send([baseIntent]);

    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(2);
  });
});

'use strict';

const request = require('supertest');
const express = require('express');

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: { isValidEd25519PublicKey: (value) => /^G[A-Z2-7]{55}$/.test(value || '') },
}));
jest.mock('../src/logger', () => ({ logger: require('pino')({ level: 'silent' }) }));
jest.mock('../prismaClient', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    paymentRequest: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
  isPrismaConnectionError: () => false,
}));
jest.mock('../src/services/ownershipService', () => ({
  authenticateUsernameOwner: jest.fn(),
}));
jest.mock('../src/sse/paymentRequestEvents', () => ({
  notifyPaymentRequestUpdate: jest.fn().mockResolvedValue(true),
}));
jest.mock('../src/webhookWorker', () => ({
  dispatchPaymentRequestWebhooks: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/middleware/signatureRateLimit', () => ({
  createSignatureRateLimiter: () => (req, res, next) => next(),
}));

const { prisma } = require('../prismaClient');
const { authenticateUsernameOwner } = require('../src/services/ownershipService');
const { buildErrorHandler } = require('../src/middleware/errorHandler');
const { dispatchPaymentRequestWebhooks } = require('../src/webhookWorker');
const { notifyPaymentRequestUpdate } = require('../src/sse/paymentRequestEvents');
const buildRouter = require('../src/routes/v1/paymentRequestRoutes');

const ISSUER = `G${'A'.repeat(55)}`;

const buildApp = () =>
  express()
    .use(express.json())
    .use('/', buildRouter(null))
    .use(buildErrorHandler(() => false));

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({
    username: 'alice*localhost',
    address: ISSUER,
    deletedAt: null,
  });
  authenticateUsernameOwner.mockResolvedValue({
    username: 'alice*localhost',
    address: ISSUER,
  });
});

describe('payment request routes', () => {
  test('creates a payment request', async () => {
    const created = {
      id: 'request-1',
      tag: 'alice*localhost',
      destination: ISSUER,
      amount: '10',
      asset: 'XLM',
      memoType: 'text',
      memo: 'invoice-42',
      description: 'Test invoice',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86400000),
      paidAt: null,
      transactionHash: null,
      createdAt: new Date(),
    };
    prisma.paymentRequest.create.mockResolvedValue(created);

    const res = await request(buildApp())
      .post('/payment-requests')
      .set('X-Stellar-Signature', 'signed-message')
      .set('X-Stellar-Signer', ISSUER)
      .set('Idempotency-Key', 'create-payment-request')
      .send({
        tag: 'alice',
        amount: '10',
        asset: 'XLM',
        memo: 'invoice-42',
        description: 'Test invoice',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('request-1');
    expect(res.body.link).toContain('/pay/alice');
    expect(res.body.sep7).toContain('web+stellar:pay');
  });

  test('returns 404 for an unknown tag', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/payment-requests')
      .set('X-Stellar-Signature', 'signed-message')
      .set('X-Stellar-Signer', ISSUER)
      .set('Idempotency-Key', 'unknown-tag')
      .send({ tag: 'nobody', amount: '10' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('returns 401 for a bad signature', async () => {
    authenticateUsernameOwner.mockRejectedValue(Object.assign(
      new Error('Signature verification failed'),
      { statusCode: 401 },
    ));
    const res = await request(buildApp())
      .post('/payment-requests')
      .set('X-Stellar-Signature', 'bad')
      .set('X-Stellar-Signer', ISSUER)
      .set('Idempotency-Key', 'bad-signature')
      .send({ tag: 'alice', amount: '10' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('returns 422 for invalid body', async () => {
    const res = await request(buildApp())
      .post('/payment-requests')
      .set('Idempotency-Key', 'invalid-body')
      .send({ tag: '', amount: '0' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('returns 409 cancelling a paid request', async () => {
    prisma.paymentRequest.findUnique.mockResolvedValue({
      id: 'request-1',
      tag: 'alice*localhost',
      status: 'paid',
      expiresAt: new Date(Date.now() + 86400000),
    });
    const res = await request(buildApp())
      .post('/payment-requests/request-1/cancel')
      .set('X-Stellar-Signature', 'signed-message')
      .set('X-Stellar-Signer', ISSUER)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  test('cancelling sends the payment_request.cancelled webhook', async () => {
    const pending = {
      id: 'request-1',
      tag: 'alice*localhost',
      destination: ISSUER,
      amount: '10',
      asset: 'XLM',
      memo: 'invoice-42',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86400000),
    };
    prisma.paymentRequest.findUnique.mockResolvedValue(pending);
    prisma.paymentRequest.update.mockResolvedValue({ ...pending, status: 'cancelled' });

    const res = await request(buildApp())
      .post('/payment-requests/request-1/cancel')
      .set('X-Stellar-Signature', 'signed-message')
      .set('X-Stellar-Signer', ISSUER)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
    expect(notifyPaymentRequestUpdate).toHaveBeenCalledWith({ requestId: 'request-1', status: 'cancelled' });
    expect(dispatchPaymentRequestWebhooks).toHaveBeenCalledWith(expect.objectContaining({
      status: 'cancelled',
      request: expect.objectContaining({ id: 'request-1', status: 'cancelled' }),
    }));
  });

  test('a webhook failure does not fail the cancel', async () => {
    const pending = { id: 'request-1', tag: 'alice*localhost', destination: ISSUER, status: 'pending', expiresAt: new Date(Date.now() + 86400000) };
    prisma.paymentRequest.findUnique.mockResolvedValue(pending);
    prisma.paymentRequest.update.mockResolvedValue({ ...pending, status: 'cancelled' });
    dispatchPaymentRequestWebhooks.mockRejectedValueOnce(new Error('redis down'));

    const res = await request(buildApp())
      .post('/payment-requests/request-1/cancel')
      .set('X-Stellar-Signature', 'signed-message')
      .set('X-Stellar-Signer', ISSUER)
      .send({});
    expect(res.status).toBe(200);
  });
});

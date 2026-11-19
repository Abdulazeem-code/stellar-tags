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
jest.mock('../src/middleware/signatureRateLimit', () => ({
  createSignatureRateLimiter: () => (req, res, next) => next(),
}));

const { prisma } = require('../prismaClient');
const { authenticateUsernameOwner } = require('../src/services/ownershipService');
const { buildErrorHandler } = require('../src/middleware/errorHandler');
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
});

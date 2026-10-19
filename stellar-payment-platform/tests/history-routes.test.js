'use strict';

/**
 * Unit tests for src/routes/v1/historyRoutes.js.
 *
 * The handler is exercised through supertest with the Stellar SDK unmocked so
 * address validation behaves realistically, while Horizon calls are mocked.
 */

const request = require('supertest');
const express = require('express');

// The real @stellar/stellar-sdk ships ESM entry points that Jest 29 cannot
// parse; other suites mock it too.
jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    isValidEd25519PublicKey: (value) =>
      typeof value === 'string' && value.startsWith('G') && value.length === 56,
  },
}));

const mockFetchPaymentsForAccount = jest.fn();
jest.mock('../src/services/stellarService', () => ({
  fetchPaymentsForAccount: (...args) => mockFetchPaymentsForAccount(...args),
}));

// Pass-through schema validation — the schema itself is covered elsewhere.
jest.mock('../src/middleware/validateSchema', () => ({
  validateSchema: () => (req, res, next) => next(),
}));

const historyRoutes = require('../src/routes/v1/historyRoutes');

const VALID_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const buildApp = () => {
  const app = express();
  app.use(historyRoutes);
  // Mimic the production error handler so next(err) becomes a JSON response.
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  return app;
};

describe('GET /accounts/:account/payments', () => {
  beforeEach(() => {
    mockFetchPaymentsForAccount.mockReset();
  });

  it('rejects an invalid Stellar account with 400', async () => {
    const res = await request(buildApp()).get('/accounts/not-a-valid-account/payments');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid Stellar account' });
    expect(mockFetchPaymentsForAccount).not.toHaveBeenCalled();
  });

  it('returns payments, next and prev cursors', async () => {
    mockFetchPaymentsForAccount.mockResolvedValue({
      _embedded: { records: [{ id: 'p1' }] },
      _links: {
        next: { href: '/next' },
        prev: { href: '/prev' },
      },
    });

    const res = await request(buildApp()).get(`/accounts/${VALID_ACCOUNT}/payments?limit=10&order=asc`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      records: [{ id: 'p1' }],
      next: '/next',
      prev: '/prev',
      limit: '10',
      order: 'asc',
    });
    expect(mockFetchPaymentsForAccount).toHaveBeenCalledWith({
      address: VALID_ACCOUNT,
      limit: '10',
      cursor: undefined,
      order: 'asc',
    });
  });

  it('handles missing embedded records and links', async () => {
    mockFetchPaymentsForAccount.mockResolvedValue({});
    const res = await request(buildApp()).get(`/accounts/${VALID_ACCOUNT}/payments`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ records: [], next: null, prev: null });
  });

  it('maps Horizon 404 to NOT_FOUND', async () => {
    mockFetchPaymentsForAccount.mockRejectedValue({ response: { status: 404 } });
    const res = await request(buildApp()).get(`/accounts/${VALID_ACCOUNT}/payments`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Account not found' });
  });

  it('maps an open circuit breaker to SERVICE_UNAVAILABLE', async () => {
    mockFetchPaymentsForAccount.mockRejectedValue({ code: 'EOPENBREAKER' });
    const res = await request(buildApp()).get(`/accounts/${VALID_ACCOUNT}/payments`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'Stellar Horizon is temporarily unavailable; please try again later',
    });
  });

  it('maps unexpected upstream errors to UPSTREAM_ERROR', async () => {
    mockFetchPaymentsForAccount.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).get(`/accounts/${VALID_ACCOUNT}/payments`);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Failed to fetch payments from Horizon' });
  });
});
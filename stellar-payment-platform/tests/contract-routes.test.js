'use strict';

/**
 * Unit tests for src/routes/v1/contractRoutes.js.
 */

const request = require('supertest');
const express = require('express');

const mockGetContractStatus = jest.fn();
jest.mock('../src/services/contractService', () => ({
  getContractStatus: (...args) => mockGetContractStatus(...args),
}));

const contractRoutes = require('../src/routes/v1/contractRoutes');

const buildApp = () => {
  const app = express();
  app.use(contractRoutes);
  return app;
};

describe('GET /contract/status', () => {
  beforeEach(() => {
    mockGetContractStatus.mockReset();
  });

  it('returns contract status with 200', async () => {
    mockGetContractStatus.mockResolvedValue({ contract_id: 'C123', version: 1 });
    const res = await request(buildApp()).get('/contract/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contract_id: 'C123', version: 1 });
  });

  it('returns 500 with a configuration message when CONTRACT_ID is missing', async () => {
    mockGetContractStatus.mockRejectedValue(new Error('CONTRACT_ID environment variable is not set'));
    const res = await request(buildApp()).get('/contract/status');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Contract configuration is missing' });
  });

  it('returns 500 with a generic message for other failures', async () => {
    mockGetContractStatus.mockRejectedValue(new Error('upstream exploded'));
    const res = await request(buildApp()).get('/contract/status');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch contract status' });
  });
});
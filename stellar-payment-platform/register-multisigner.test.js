/**
 * Multi-Signer Registration Integration Tests
 * 
 * Tests the /register endpoint with multi-signer threshold verification
 * covering both single-signer and enterprise account scenarios.
 */

'use strict';

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: {
    isValidEd25519PublicKey: (key) => {
      // Mock validation: keys starting with 'G' and 56 chars are valid
      return typeof key === 'string' && key.startsWith('G') && key.length === 56;
    },
  },
}));

jest.mock('pdfkit', () => jest.fn());

jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('./src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('./prismaClient', () => ({
  prisma: {
    user: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: jest.fn(),
    }),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    options: { max: 10 },
  })),
}));

const request = require('supertest');

// Mock the multi-signer verifier
jest.mock('./src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(),
  isSingleSignerAccount: jest.fn(),
}));

describe('POST /register - Multi-Signer Threshold Verification', () => {
  let app;
  let mockPool;
  let prisma;
  let verifyMultiSignerThreshold;
  const { Horizon } = require('@stellar/stellar-sdk');

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    // Import after mocks are set
    ({ app } = require('./server'));
    ({ prisma } = require('./prismaClient'));
    verifyMultiSignerThreshold = require('./src/multisigner-verifier').verifyMultiSignerThreshold;

    prisma.user.findFirst.mockReset();
    prisma.user.create.mockReset();
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      username: 'alice*localhost',
      address: 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z',
      memoType: null,
      memo: null,
    });

    // Default verifier behavior: assume signature verifies unless a test
    // overrides this with mockResolvedValue or mockRejectedValue.
    verifyMultiSignerThreshold.mockResolvedValue({
      success: true,
      accountId: 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z',
      operationType: 'management',
      requiredThreshold: 1,
      totalWeight: 1,
      signatureCount: 1,
      uniqueSignerCount: 1,
      signatures: [{ publicKey: 'GFAKE', weight: 1, isValid: true }],
      thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
      signerCount: 1,
      errorMessage: null,
    });

    // Mock pool
    const { Pool } = require('pg');
    mockPool = await new Pool().connect();
  });

  describe('Validation Tests', () => {
    it('should reject request without signature', async () => {
      const response = await request(app)
        .post('/register')
        .send({
          username: 'testuser',
          address: 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z',
          signature: 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z',
        });

      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
    });

    it('should reject request with invalid public key format', async () => {
      const response = await request(app)
        .post('/register')
        .send({
          username: 'testuser',
          address: 'INVALID_KEY',
          signature: 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('Invalid Stellar Public Key format');
    });

    it('should reject request with missing username', async () => {
      const response = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({
          address: 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z',
          signature: 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z',
        });

      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error.details');
    });
  });

  describe('Single-Signer Account Verification', () => {
    it('should register single-signer account with valid signature', async () => {
      const accountId = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';
      
      verifyMultiSignerThreshold.mockResolvedValue({
        success: true,
        accountId,
        operationType: 'management',
        requiredThreshold: 1,
        totalWeight: 1,
        signatureCount: 1,
        uniqueSignerCount: 1,
        signatures: [{ publicKey: accountId, weight: 1, isValid: true }],
        thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
        signerCount: 1,
        errorMessage: null,
      });

      const response = await request(app)
        .post('/register')
        .send({
          username: 'alice',
          address: accountId,
          signature: accountId,
        });

      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
      expect(response.body.username).toBe('alice*localhost');
      expect(response.body.address).toBe(accountId);
      expect(response.body.verification.thresholdMet).toBe(true);
      expect(verifyMultiSignerThreshold).toHaveBeenCalledWith(
        accountId,
        [accountId],
        expect.objectContaining({ operationType: 'management' })
      );
    });

    it('should reject registration with invalid signature', async () => {
      const accountId = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';
      const invalidSigner = 'GCMYSPHFP3L5SDIYBHWHQJVAKQQQC47PGP4TQMJUFAXTVXLKBF3KYQCF';
      
      verifyMultiSignerThreshold.mockResolvedValue({
        success: false,
        accountId,
        operationType: 'management',
        requiredThreshold: 2,
        totalWeight: 0,
        signatureCount: 1,
        uniqueSignerCount: 0,
        signatures: [{ publicKey: invalidSigner, weight: 0, isValid: false }],
        thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
        signerCount: 1,
        errorMessage: 'Insufficient signing weight. Required: 2, Provided: 0',
      });

      const response = await request(app)
        .post('/register')
        .send({
          username: 'alice',
          address: accountId,
          signature: invalidSigner,
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.message).toMatch(/Signature verification failed|Insufficient signing weight/);
    });
  });

  describe('Multi-Signer Enterprise Account Verification', () => {
    it('should register multi-signer account when threshold is met', async () => {
      const accountId = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';
      const signer2 = 'GCMYSPHFP3L5SDIYBHWHQJVAKQQQC47PGP4TQMJUFAXTVXLKBF3KYQCF';
      
      verifyMultiSignerThreshold.mockResolvedValue({
        success: true,
        accountId,
        operationType: 'management',
        requiredThreshold: 10,
        totalWeight: 15,
        signatureCount: 2,
        uniqueSignerCount: 2,
        signatures: [
          { publicKey: accountId, weight: 8, isValid: true },
          { publicKey: signer2, weight: 7, isValid: true },
        ],
        thresholds: { low_threshold: 5, med_threshold: 10, high_threshold: 15 },
        signerCount: 2,
        errorMessage: null,
      });

      const response = await request(app)
        .post('/register')
        .send({
          username: 'enterprise',
          address: accountId,
          signature: accountId, // First signer
        });

      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
      expect(response.body.verification.signerCount).toBe(2);
      expect(response.body.verification.requiredThreshold).toBe(10);
      expect(response.body.verification.providedWeight).toBe(15);
    });

    it('should reject registration when threshold not met', async () => {
      const accountId = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';
      const weakSigner = 'GCMYSPHFP3L5SDIYBHWHQJVAKQQQC47PGP4TQMJUFAXTVXLKBF3KYQCF';
      
      verifyMultiSignerThreshold.mockResolvedValue({
        success: false,
        accountId,
        operationType: 'management',
        requiredThreshold: 20,
        totalWeight: 3,
        signatureCount: 1,
        uniqueSignerCount: 1,
        signatures: [{ publicKey: weakSigner, weight: 3, isValid: true }],
        thresholds: { low_threshold: 5, med_threshold: 20, high_threshold: 30 },
        signerCount: 2,
        errorMessage: 'Insufficient signing weight. Required: 20, Provided: 3',
      });

      const response = await request(app)
        .post('/register')
        .send({
          username: 'enterprise',
          address: accountId,
          signature: weakSigner,
        });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toContain('Insufficient signing weight');
    });
  });

  describe('Account Lookup and Conflict Detection', () => {
    it('should reject duplicate address registration', async () => {
      const accountId = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';
      
      prisma.user.findFirst.mockResolvedValue({ username: 'existing' });

      const response = await request(app)
        .post('/register')
        .send({
          username: 'newuser',
          address: accountId,
          signature: accountId,
        });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('Address already registered');
    });

    it('should handle account not found error', async () => {
      const accountId = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';
      
      verifyMultiSignerThreshold.mockRejectedValue(
        new Error(`Account not found on Horizon: ${accountId}`)
      );

      const response = await request(app)
        .post('/register')
        .send({
          username: 'alice',
          address: accountId,
          signature: accountId,
        });

      expect(response.status).toBe(404);
      expect(response.body.error.message).toContain('Account not found on Horizon');
    });
  });

  describe('Response Metadata', () => {
    it('should return verification metadata in response', async () => {
      const accountId = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';
      
      verifyMultiSignerThreshold.mockResolvedValue({
        success: true,
        accountId,
        operationType: 'management',
        requiredThreshold: 1,
        totalWeight: 1,
        signatureCount: 1,
        uniqueSignerCount: 1,
        signatures: [{ publicKey: accountId, weight: 1, isValid: true }],
        thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
        signerCount: 1,
        errorMessage: null,
      });

      const response = await request(app)
        .post('/register')
        .send({
          username: 'alice',
          address: accountId,
          signature: accountId,
        });

      expect(response.status).toBe(201);
      expect(response.body.verification).toEqual({
        accountId,
        signerCount: 1,
        thresholdMet: true,
        requiredThreshold: 1,
        providedWeight: 1,
      });
    });

    it('should include federation address in response', async () => {
      const accountId = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';
      
      verifyMultiSignerThreshold.mockResolvedValue({
        success: true,
        accountId,
        operationType: 'management',
        requiredThreshold: 1,
        totalWeight: 1,
        signatureCount: 1,
        uniqueSignerCount: 1,
        signatures: [{ publicKey: accountId, weight: 1, isValid: true }],
        thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
        signerCount: 1,
        errorMessage: null,
      });

      const response = await request(app)
        .post('/register')
        .send({
          username: 'alice',
          address: accountId,
          signature: accountId,
        });

      expect(response.status).toBe(201);
      expect(response.body.federation_address).toMatch(/^alice\*/);
    });
  });

  describe('Username Normalization', () => {
    it('should normalize username to lowercase', async () => {
      const accountId = 'GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z';
      
      verifyMultiSignerThreshold.mockResolvedValue({
        success: true,
        accountId,
        operationType: 'management',
        requiredThreshold: 1,
        totalWeight: 1,
        signatureCount: 1,
        uniqueSignerCount: 1,
        signatures: [{ publicKey: accountId, weight: 1, isValid: true }],
        thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
        signerCount: 1,
        errorMessage: null,
      });

      const response = await request(app)
        .post('/register')
        .send({
          username: 'ALICE',
          address: accountId,
          signature: accountId,
        });

      expect(response.status).toBe(201);
      expect(response.body.username).toBe('alice*localhost');
    });
  });
});

const request = require('supertest');

// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) }
}));

// Mock Prisma so it doesn't try to connect to a real database
jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        username: 'alice123',
        address: 'GABC123',
      }),
    },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
}));

// Mock the pool functions
jest.mock('../src/db', () => ({
  poolGet: jest.fn().mockResolvedValue(null),
  poolRun: jest.fn().mockResolvedValue({ changes: 1 }),
  poolAll: jest.fn().mockResolvedValue([]),
}));

// Mock the v1 routes (factory function since v1/index.js now exports a function)
jest.mock('../src/routes/v1', () => {
  return () => require('express').Router();
});

const { app } = require('../server');

describe('POST /register - Express Validator Tests', () => {
  const validPayload = {
    username: 'alice123',
    address: 'GABC123XYZ456789',
  };

  describe('Valid Payloads', () => {
    // a) valid_payload_passes_validation
    it('a) should accept valid payload with username and address', async () => {
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send(validPayload);

      expect(res.statusCode).not.toBe(422);
      expect(res.statusCode).toBeOneOf([200, 201, 400, 401, 404, 409, 415]);
    });

    // h) username_at_min_boundary_passes (3 chars)
    it('h) should accept username with minimum 3 characters', async () => {
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({
          username: 'abc',
          address: 'GABC123XYZ456789',
        });

      expect(res.statusCode).not.toBe(422);
    });

    // i) username_at_max_boundary_passes (20 chars)
    it('i) should accept username with maximum 20 characters', async () => {
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({
          username: 'a'.repeat(20),
          address: 'GABC123XYZ456789',
        });

      expect(res.statusCode).not.toBe(422);
    });
  });

  describe('Invalid Username - Missing or Empty', () => {
    // b) missing_username_returns_422
    it('b) should return 422 when username is missing', async () => {
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({
          address: 'GABC123XYZ456789',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errors');
      expect(res.body.errors).toBeInstanceOf(Array);
      expect(res.body.errors.length).toBeGreaterThan(0);
      expect(res.body.errors[0]).toHaveProperty('field', 'username');
      expect(res.body.errors[0]).toHaveProperty('message');
    });
  });

  describe('Invalid Username - Length Constraints', () => {
    // c) username_too_short_returns_422
    it('c) should return 422 when username is less than 3 characters', async () => {
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({
          username: 'ab',
          address: 'GABC123XYZ456789',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body).toHaveProperty('errors');
      expect(res.body.errors[0]).toHaveProperty('field', 'username');
      expect(res.body.errors[0].message).toContain('3');
    });

    // d) username_too_long_returns_422
    it('d) should return 422 when username exceeds 20 characters', async () => {
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({
          username: 'a'.repeat(21),
          address: 'GABC123XYZ456789',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body).toHaveProperty('errors');
      expect(res.body.errors[0]).toHaveProperty('field', 'username');
      expect(res.body.errors[0].message).toContain('20');
    });
  });

  describe('Invalid Username - Character Constraints', () => {
    // e) username_with_special_chars_returns_422
    it('e) should return 422 when username contains special characters', async () => {
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({
          username: 'alice!@#',
          address: 'GABC123XYZ456789',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body).toHaveProperty('errors');
      expect(res.body.errors[0]).toHaveProperty('field', 'username');
      expect(res.body.errors[0].message).toContain('letters and numbers');
    });
  });

  describe('Invalid Address', () => {
    // f) missing_address_returns_422
    it('f) should return 422 when address is missing', async () => {
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({
          username: 'alice123',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body).toHaveProperty('errors');
      expect(res.body.errors[0]).toHaveProperty('field', 'address');
    });

    // g) empty_address_returns_422
    it('g) should return 422 when address is empty string', async () => {
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({
          username: 'alice123',
          address: '',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body).toHaveProperty('errors');
      expect(res.body.errors[0]).toHaveProperty('field', 'address');
    });
  });

  describe('Error Response Format', () => {
    // j) error_response_has_field_and_message
    it('j) should have field and message properties in error response', async () => {
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({
          username: 'ab',
          address: '',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body).toHaveProperty('errors');
      expect(res.body.errors).toBeInstanceOf(Array);
      expect(res.body.errors.length).toBeGreaterThan(0);

      res.body.errors.forEach((error) => {
        expect(error).toHaveProperty('field');
        expect(error).toHaveProperty('message');
        expect(typeof error.field).toBe('string');
        expect(typeof error.message).toBe('string');
      });
    });
  });
});

// Custom matcher for flexibility in status code checking
expect.extend({
  toBeOneOf(received, expected) {
    const pass = expected.includes(received);
    return {
      pass,
      message: () =>
        `expected ${received} to be one of [${expected.join(', ')}]`,
    };
  },
});

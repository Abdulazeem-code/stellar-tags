// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

// Mock Prisma so it doesn't try to connect to a real database
jest.mock('../../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
}));

const { rejectNestedObjects } = require('../../server');

describe('rejectNestedObjects middleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    // Build fresh mock Express objects for each test
    next = jest.fn();

    const json = jest.fn();
    res = {
      status: jest.fn().mockReturnValue({ json }),
      json,
    };
  });

  // ---------------------------------------------------------------------------
  // Payloads that should pass through (next() is called)
  // ---------------------------------------------------------------------------
  describe('standard (primitive) payloads — should call next()', () => {
    it('calls next() when req.query and req.body are both empty', () => {
      req = { query: {}, body: {} };

      rejectNestedObjects(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next() when req.query has only string values', () => {
      req = { query: { q: 'client*localhost', type: 'name' }, body: {} };

      rejectNestedObjects(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next() when req.body has only string values', () => {
      req = {
        query: {},
        body: { username: 'alice', address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ' },
      };

      rejectNestedObjects(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next() when values are numbers', () => {
      req = { query: {}, body: { amount: 100, threshold: 2 } };

      rejectNestedObjects(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next() when values are booleans', () => {
      req = { query: {}, body: { active: true, verified: false } };

      rejectNestedObjects(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next() when a value is null', () => {
      req = { query: {}, body: { memo: null } };

      rejectNestedObjects(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next() when req.query and req.body are both undefined', () => {
      req = { query: undefined, body: undefined };

      rejectNestedObjects(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Payloads that should be rejected (400 returned, next() not called)
  // ---------------------------------------------------------------------------
  describe('nested (non-primitive) payloads — should return 400', () => {
    it('returns 400 when req.body contains a nested object', () => {
      req = { query: {}, body: { filter: { admin: true } } };

      rejectNestedObjects(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.status(400).json).toHaveBeenCalledWith({
        success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Invalid parameter type: nested objects and arrays are not allowed.',
      },
      });
    });

    it('returns 400 when req.body contains an array', () => {
      req = { query: {}, body: { signers: ['GABC', 'GDEF'] } };

      rejectNestedObjects(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when req.query contains a nested object', () => {
      req = { query: { filter: { role: 'admin' } }, body: {} };

      rejectNestedObjects(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.status(400).json).toHaveBeenCalledWith({
        success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Invalid parameter type: nested objects and arrays are not allowed.',
      },
      });
    });

    it('returns 400 when req.query contains an array', () => {
      req = { query: { ids: ['1', '2', '3'] }, body: {} };

      rejectNestedObjects(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 on the first offending field and does not call next()', () => {
      req = {
        query: {},
        body: { username: 'alice', injected: { $gt: '' }, address: 'GABC' },
      };

      rejectNestedObjects(req, res, next);

      expect(next).not.toHaveBeenCalled();
      // status(400) should be called exactly once — middleware returns early
      expect(res.status).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when a deeply nested object is present in req.body', () => {
      req = { query: {}, body: { payload: { nested: { deep: true } } } };

      rejectNestedObjects(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns the correct error detail message in the response body', () => {
      req = { query: {}, body: { attack: { $where: 'malicious' } } };

      rejectNestedObjects(req, res, next);

      expect(res.status(400).json).toHaveBeenCalledWith({
        success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Invalid parameter type: nested objects and arrays are not allowed.',
      },
      });
    });
  });
});

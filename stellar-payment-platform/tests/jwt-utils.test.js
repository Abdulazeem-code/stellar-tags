'use strict';

/**
 * Unit tests for src/utils/jwt.js — RS256 signing, verification, JWKS and
 * the requireAuth middleware.
 *
 * The module reads JWT_PRIVATE_KEY / JWT_PUBLIC_KEY from the environment at
 * require time, so each suite re-requires it after setting the keys.
 */

const crypto = require('crypto');

// Generate a real RSA key pair used across the suite.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const PRIVATE_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });

const ORIGINAL_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY;
const ORIGINAL_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY;

const restoreJwtEnv = () => {
  if (ORIGINAL_PRIVATE_KEY === undefined) delete process.env.JWT_PRIVATE_KEY;
  else process.env.JWT_PRIVATE_KEY = ORIGINAL_PRIVATE_KEY;
  if (ORIGINAL_PUBLIC_KEY === undefined) delete process.env.JWT_PUBLIC_KEY;
  else process.env.JWT_PUBLIC_KEY = ORIGINAL_PUBLIC_KEY;
};

const loadJwtModule = () => {
  jest.resetModules();
  process.env.JWT_PRIVATE_KEY = PRIVATE_PEM;
  process.env.JWT_PUBLIC_KEY = PUBLIC_PEM;
  return require('../src/utils/jwt');
};

afterAll(() => {
  restoreJwtEnv();
});

describe('jwt utils (configured keys)', () => {
  let jwtUtils;

  beforeEach(() => {
    jwtUtils = loadJwtModule();
  });

  describe('signToken / verifyToken', () => {
    it('signs and verifies a token round-trip', () => {
      const token = jwtUtils.signToken({ username: 'alice' });
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      const decoded = jwtUtils.verifyToken(token);
      expect(decoded.username).toBe('alice');
    });

    it('honours custom sign options such as expiresIn', () => {
      const token = jwtUtils.signToken({ sub: '1' }, { expiresIn: '2h' });
      const decoded = jwtUtils.verifyToken(token);
      expect(decoded.sub).toBe('1');
    });

    it('rejects tampered tokens', () => {
      const token = jwtUtils.signToken({ username: 'alice' });
      const [header, payload, signature] = token.split('.');
      const tampered = `${header}.${payload}.${signature.slice(0, -1)}a`;
      expect(() => jwtUtils.verifyToken(tampered)).toThrow();
    });
  });

  describe('getJwks', () => {
    it('returns a JWKS document with a stable kid', () => {
      const jwks = jwtUtils.getJwks();
      expect(jwks.keys).toHaveLength(1);
      const key = jwks.keys[0];
      expect(key.kty).toBe('RSA');
      expect(key.alg).toBe('RS256');
      expect(key.use).toBe('sig');
      expect(key.n).toBeTruthy();
      expect(key.e).toBeTruthy();
      expect(key.kid).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('produces the same kid across calls', () => {
      expect(jwtUtils.getJwks().keys[0].kid).toBe(jwtUtils.getJwks().keys[0].kid);
    });
  });

  describe('requireAuth middleware', () => {
    const fakeRes = () => {
      const res = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    };

    it('attaches the decoded payload to req.user and calls next', () => {
      const token = jwtUtils.signToken({ username: 'bob' });
      const req = { headers: { authorization: `Bearer ${token}` } };
      const res = fakeRes();
      const next = jest.fn();

      jwtUtils.requireAuth(req, res, next);

      expect(req.user.username).toBe('bob');
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects a missing or malformed Authorization header with 401', () => {
      const req = { headers: {} };
      const res = fakeRes();
      const next = jest.fn();

      jwtUtils.requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing or malformed Authorization header.' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects an expired token with 401 and a specific message', () => {
      const token = jwtUtils.signToken({ username: 'bob' }, { expiresIn: '-10s' });
      const req = { headers: { authorization: `Bearer ${token}` } };
      const res = fakeRes();
      const next = jest.fn();

      jwtUtils.requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token has expired.' });
    });

    it('rejects an invalid token with 401 and a generic message', () => {
      const req = { headers: { authorization: 'Bearer not-a-real-token' } };
      const res = fakeRes();
      const next = jest.fn();

      jwtUtils.requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token.' });
    });
  });
});

describe('jwt utils (missing keys)', () => {
  it('signToken throws when JWT_PRIVATE_KEY is missing', () => {
    jest.resetModules();
    delete process.env.JWT_PRIVATE_KEY;
    process.env.JWT_PUBLIC_KEY = PUBLIC_PEM;
    const { signToken } = require('../src/utils/jwt');
    expect(() => signToken({ a: 1 })).toThrow('JWT_PRIVATE_KEY is not configured.');
  });

  it('verifyToken throws when JWT_PUBLIC_KEY is missing', () => {
    jest.resetModules();
    process.env.JWT_PRIVATE_KEY = PRIVATE_PEM;
    delete process.env.JWT_PUBLIC_KEY;
    const { verifyToken } = require('../src/utils/jwt');
    expect(() => verifyToken('x.y.z')).toThrow('JWT_PUBLIC_KEY is not configured.');
  });

  it('getJwks throws when JWT_PUBLIC_KEY is missing', () => {
    jest.resetModules();
    process.env.JWT_PRIVATE_KEY = PRIVATE_PEM;
    delete process.env.JWT_PUBLIC_KEY;
    const { getJwks } = require('../src/utils/jwt');
    expect(() => getJwks()).toThrow('JWT_PUBLIC_KEY is not configured.');
  });
});
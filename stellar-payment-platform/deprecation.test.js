'use strict';

jest.mock('./src/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const { logger } = require('./src/logger');
const {
  deprecationMiddleware,
  findDeprecation,
  pathMatches,
  toHttpDate,
  resetDeprecationLogger,
} = require('./src/middleware/deprecation');

const makeRes = () => {
  const headers = {};
  return {
    headers,
    set(key, value) {
      headers[key] = value;
      return this;
    },
  };
};

const run = (entry, method, path) => {
  const middleware = deprecationMiddleware({ registry: [entry] });
  const req = { method, path };
  const res = makeRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
};

beforeEach(() => {
  logger.warn.mockClear();
  resetDeprecationLogger();
});

describe('deprecation middleware', () => {
  it('attaches Deprecation, Sunset and Link headers for a matching endpoint', () => {
    const { res, nextCalled } = run(
      {
        method: 'GET',
        path: '/api/v1/lookup',
        deprecatedSince: '2026-08-29',
        sunset: '2027-02-28',
        replacement: '/api/v2/lookup',
        documentation: 'https://docs.example.com/deprecations/lookup',
      },
      'GET',
      '/api/v1/lookup',
    );

    expect(res.headers.Deprecation).toBe(new Date('2026-08-29').toUTCString());
    expect(res.headers.Sunset).toBe(new Date('2027-02-28').toUTCString());
    expect(res.headers.Link).toBe(
      '<https://docs.example.com/deprecations/lookup>; rel="deprecation"',
    );
    expect(res.headers.Warning).toContain('299');
    expect(nextCalled).toBe(true);
  });

  it('ignores requests that do not match any deprecation', () => {
    const { res, nextCalled } = run(
      { method: 'GET', path: '/api/v1/lookup', deprecatedSince: '2026-08-29', sunset: '2027-02-28' },
      'GET',
      '/api/v1/active',
    );
    expect(res.headers.Deprecation).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('matches wildcard paths', () => {
    const entry = { method: 'GET', path: '/api/v1/receipts/*', deprecatedSince: '2026-08-29', sunset: '2027-02-28' };
    const { res } = run(entry, 'GET', '/api/v1/receipts/abc123');
    expect(res.headers.Deprecation).toBeDefined();
  });

  it('logs a server-side warning exactly once per endpoint', () => {
    const entry = { method: 'GET', path: '/api/v1/stats', deprecatedSince: '2026-08-29', sunset: '2027-01-31', replacement: '/api/v2/stats' };
    const mw = deprecationMiddleware({ registry: [entry] });
    const req = { method: 'GET', path: '/api/v1/stats' };
    mw(req, makeRes(), () => {});
    mw(req, makeRes(), () => {});
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toContain('/api/v2/stats');
  });

  it('uses method "*" to match any HTTP verb', () => {
    const entry = { method: '*', path: '/api/v1/legacy', deprecatedSince: '2026-08-29', sunset: '2027-02-28' };
    const { res } = run(entry, 'DELETE', '/api/v1/legacy');
    expect(res.headers.Deprecation).toBeDefined();
  });
});

describe('pathMatches', () => {
  it('returns true on exact match', () => {
    expect(pathMatches('/api/v1/lookup', '/api/v1/lookup')).toBe(true);
  });
  it('returns false on mismatch', () => {
    expect(pathMatches('/api/v1/lookup', '/api/v1/other')).toBe(false);
  });
  it('supports wildcard', () => {
    expect(pathMatches('/api/v1/x/*', '/api/v1/x/1/2')).toBe(true);
  });
});

describe('toHttpDate', () => {
  it('formats ISO dates as HTTP-dates', () => {
    expect(toHttpDate('2027-02-28')).toBe(new Date('2027-02-28').toUTCString());
  });
  it('returns null for invalid dates', () => {
    expect(toHttpDate('not-a-date')).toBeNull();
  });
});

describe('findDeprecation', () => {
  it('finds a registered deprecation by method and path', () => {
    const registry = [{ method: 'POST', path: '/api/v1/payments/bulk', deprecatedSince: '2026-08-29', sunset: '2027-03-31' }];
    expect(findDeprecation('post', '/api/v1/payments/bulk', registry)).toBeDefined();
    expect(findDeprecation('GET', '/api/v1/payments/bulk', registry)).toBeNull();
  });
});

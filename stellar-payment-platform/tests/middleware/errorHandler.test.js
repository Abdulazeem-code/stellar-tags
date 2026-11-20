'use strict';

const express = require('express');
const request = require('supertest');

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock('../../src/logger', () => ({ logger: mockLogger }));

const { buildErrorHandler, notFoundHandler } = require('../../src/middleware/errorHandler');
const { ApiError, ERROR_CODES, codeForStatus, errorBody } = require('../../src/errors');

const NOT_A_CONNECTION_ERROR = () => false;

const buildApp = (thrower, { isPrismaConnectionError = NOT_A_CONNECTION_ERROR } = {}) => {
  const app = express();
  app.use((req, res, next) => {
    req.correlationId = 'test-correlation-id';
    next();
  });
  app.use(express.json());
  app.post('/boom', thrower);
  app.get('/boom', thrower);
  app.use(notFoundHandler);
  app.use(buildErrorHandler(isPrismaConnectionError));
  return app;
};

describe('error envelope', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('shape', () => {
    test('wraps an ApiError as { success, error: { code, message } }', async () => {
      const app = buildApp((req, res, next) => next(new ApiError('NOT_FOUND', 'Name tag not found')));
      const res = await request(app).get('/boom');

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Name tag not found' },
      });
    });

    test('includes details when the error carries them', async () => {
      const details = [{ field: 'username', message: 'username is required' }];
      const app = buildApp((req, res, next) =>
        next(new ApiError('VALIDATION_FAILED', 'Invalid request body', { details })),
      );
      const res = await request(app).post('/boom').send({});

      expect(res.status).toBe(422);
      expect(res.body.error.details).toEqual(details);
    });

    test('omits details when there are none', async () => {
      const app = buildApp((req, res, next) => next(new ApiError('FORBIDDEN', 'nope')));
      const res = await request(app).get('/boom');

      expect(res.body.error).not.toHaveProperty('details');
    });

    test('carries the correlation id so a response ties back to its logs', async () => {
      const app = buildApp((req, res, next) => next(new ApiError('CONFLICT', 'taken')));
      const res = await request(app).get('/boom');

      expect(res.body.correlation_id).toBe('test-correlation-id');
    });

    test('never uses the legacy flat string or detail keys', async () => {
      const app = buildApp((req, res, next) => next(new ApiError('INVALID_INPUT', 'bad')));
      const res = await request(app).get('/boom');

      expect(typeof res.body.error).toBe('object');
      expect(res.body).not.toHaveProperty('detail');
      expect(res.body).not.toHaveProperty('errors');
      expect(res.body).not.toHaveProperty('statusCode');
    });
  });

  describe('status and code mapping', () => {
    test.each(Object.entries(ERROR_CODES))('%s maps to %i', async (code, status) => {
      const app = buildApp((req, res, next) => next(new ApiError(code)));
      const res = await request(app).get('/boom');

      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
    });

    test('derives a code for a bare error carrying only a status', async () => {
      const app = buildApp((req, res, next) => {
        const err = new Error('gone');
        err.statusCode = 404;
        next(err);
      });
      const res = await request(app).get('/boom');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    test('falls back to INTERNAL_ERROR for an unclassified throw', async () => {
      const app = buildApp(() => {
        throw new Error('kaboom');
      });
      const res = await request(app).get('/boom');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });

    test('reports a Prisma connection failure as SERVICE_UNAVAILABLE', async () => {
      const app = buildApp(
        (req, res, next) => next(new Error('Cannot reach database')),
        { isPrismaConnectionError: () => true },
      );
      const res = await request(app).get('/boom');

      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service Unavailable',
      });
    });

    test('classifies an oversized payload as PAYLOAD_TOO_LARGE', async () => {
      const app = buildApp((req, res, next) => {
        const err = new Error('too big');
        err.type = 'entity.too.large';
        next(err);
      });
      const res = await request(app).post('/boom').send({});

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    test('classifies malformed JSON as INVALID_INPUT', async () => {
      const app = buildApp((req, res, next) => next());
      const res = await request(app)
        .post('/boom')
        .set('Content-Type', 'application/json')
        .send('{"broken":');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Malformed JSON payload' });
    });
  });

  describe('5xx handling', () => {
    test('hides an unexpected internal message and logs it with a reference id', async () => {
      const app = buildApp(() => {
        throw new Error('connection string user:hunter2@db');
      });
      const res = await request(app).get('/boom');

      expect(res.body.error.message).toBe('Internal Server Error');
      expect(res.body.error.message).not.toContain('hunter2');
      expect(res.body.reference_id).toEqual(expect.any(String));
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(res.body.reference_id),
        expect.any(Error),
      );
    });

    test('keeps a 5xx message an author chose deliberately', async () => {
      const app = buildApp((req, res, next) =>
        next(new ApiError('UPSTREAM_ERROR', 'Failed to fetch payments from Horizon')),
      );
      const res = await request(app).get('/boom');

      expect(res.status).toBe(502);
      expect(res.body.error.message).toBe('Failed to fetch payments from Horizon');
    });

    test('does not attach a reference id to a 4xx', async () => {
      const app = buildApp((req, res, next) => next(new ApiError('NOT_FOUND')));
      const res = await request(app).get('/boom');

      expect(res.body).not.toHaveProperty('reference_id');
    });
  });

  describe('unmatched routes', () => {
    test('answers 404 in the same envelope', async () => {
      const app = buildApp((req, res) => res.json({ ok: true }));
      const res = await request(app).get('/no-such-route');

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Cannot GET /no-such-route' },
      });
    });
  });

  test('leaves an already-sent response alone', async () => {
    const app = buildApp((req, res, next) => {
      res.status(200).json({ ok: true });
      next(new ApiError('INTERNAL_ERROR'));
    });
    const res = await request(app).get('/boom');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('errors module', () => {
  test('defaults an unknown code to INTERNAL_ERROR rather than trusting input', () => {
    const err = new ApiError('NOT_A_REAL_CODE');
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.statusCode).toBe(500);
  });

  test('allows an explicit status override', () => {
    expect(new ApiError('UPSTREAM_ERROR', 'x', { statusCode: 500 }).statusCode).toBe(500);
  });

  test('preserves the cause for logging', () => {
    const cause = new Error('root');
    expect(new ApiError('INTERNAL_ERROR', 'wrapped', { cause }).cause).toBe(cause);
  });

  test('maps unknown statuses to a sensible code', () => {
    expect(codeForStatus(418)).toBe('INVALID_INPUT');
    expect(codeForStatus(599)).toBe('INTERNAL_ERROR');
    expect(codeForStatus(404)).toBe('NOT_FOUND');
  });

  test('errorBody omits optional members when absent', () => {
    expect(errorBody('NOT_FOUND', 'missing')).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'missing' },
    });
  });
});

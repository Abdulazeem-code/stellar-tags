'use strict';

const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const {
  validateSchema,
  BODY_STATUS,
  REQUEST_STATUS,
  BODY_CODE,
  REQUEST_CODE,
} = require('../../src/middleware/validateSchema');

const buildApp = (schemas, handler) => {
  const app = express();
  app.set('query parser', 'simple');
  app.use(express.json());
  const route = handler || ((req, res) => res.json({ body: req.body, query: req.query }));
  app.post('/t', validateSchema(schemas), route);
  app.get('/t', validateSchema(schemas), route);
  return app;
};

describe('validateSchema middleware', () => {
  describe('request bodies', () => {
    const schemas = {
      body: z.object({
        name: z.string({ error: 'name is required' }).min(2, 'name must be at least 2 characters'),
        age: z.coerce.number().int().optional(),
      }),
    };

    test('passes a valid body through to the handler', async () => {
      const res = await request(buildApp(schemas)).post('/t').send({ name: 'ada' });

      expect(res.status).toBe(200);
      expect(res.body.body).toEqual({ name: 'ada' });
    });

    test('answers 422 with field and message for an invalid body', async () => {
      const res = await request(buildApp(schemas)).post('/t').send({ name: 'a' });

      expect(res.status).toBe(BODY_STATUS);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(BODY_CODE);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Invalid request body',
          details: [{ field: 'name', message: 'name must be at least 2 characters' }],
        },
      });
    });

    test('reports a missing field rather than crashing', async () => {
      const res = await request(buildApp(schemas)).post('/t').send({});

      expect(res.status).toBe(422);
      expect(res.body.error.details).toEqual([{ field: 'name', message: 'name is required' }]);
    });

    test('reports every invalid field at once', async () => {
      const multi = {
        body: z.object({
          a: z.string({ error: 'a is required' }),
          b: z.string({ error: 'b is required' }),
        }),
      };
      const res = await request(buildApp(multi)).post('/t').send({});

      expect(res.status).toBe(422);
      expect(res.body.error.details.map((e) => e.field).sort()).toEqual(['a', 'b']);
    });

    test('replaces the body with parsed values so handlers skip re-checking types', async () => {
      const res = await request(buildApp(schemas)).post('/t').send({ name: 'ada', age: '42' });

      expect(res.body.body.age).toBe(42);
      expect(typeof res.body.body.age).toBe('number');
    });

    test('never reaches the handler when validation fails', async () => {
      const handler = jest.fn((req, res) => res.json({ ok: true }));
      await request(buildApp(schemas, handler)).post('/t').send({ name: 'a' });

      expect(handler).not.toHaveBeenCalled();
    });

    test('treats a missing body as an empty object', async () => {
      const res = await request(buildApp(schemas)).post('/t');

      expect(res.status).toBe(422);
      expect(res.body.error.details[0].field).toBe('name');
    });

    test('labels a whole-object failure with _root', async () => {
      const rootRefine = {
        body: z
          .object({ a: z.string().optional(), b: z.string().optional() })
          .refine((value) => Boolean(value.a || value.b), { error: 'a or b is required' }),
      };
      const res = await request(buildApp(rootRefine)).post('/t').send({});

      expect(res.body.error.details).toEqual([{ field: '_root', message: 'a or b is required' }]);
    });
  });

  describe('query parameters', () => {
    const schemas = {
      query: z.object({
        q: z.string({ error: "Missing 'q' parameter" }).min(1),
        limit: z.coerce.number().int().optional(),
      }),
    };

    test('passes a valid query through to the handler', async () => {
      const res = await request(buildApp(schemas)).get('/t?q=alice');

      expect(res.status).toBe(200);
      expect(res.body.query.q).toBe('alice');
    });

    test('answers 400 rather than 422 for an invalid query', async () => {
      const res = await request(buildApp(schemas)).get('/t');

      expect(res.status).toBe(REQUEST_STATUS);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(REQUEST_CODE);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid request query',
          details: [{ field: 'q', message: "Missing 'q' parameter" }],
        },
      });
    });

    test('replaces the query so numeric params arrive coerced', async () => {
      const res = await request(buildApp(schemas)).get('/t?q=alice&limit=7');

      expect(res.body.query.limit).toBe(7);
    });
  });

  describe('combining body and query', () => {
    const schemas = {
      body: z.object({ name: z.string({ error: 'name is required' }) }),
      query: z.object({ q: z.string({ error: "Missing 'q' parameter" }) }),
    };

    test('validates the body first when both are invalid', async () => {
      const res = await request(buildApp(schemas)).post('/t').send({});

      expect(res.status).toBe(422);
      expect(res.body.error.details[0].field).toBe('name');
    });

    test('reports the query once the body is valid', async () => {
      const res = await request(buildApp(schemas)).post('/t').send({ name: 'ada' });

      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('q');
    });
  });

  test('is a no-op when no schemas are supplied', async () => {
    const app = express();
    app.use(express.json());
    app.post('/t', validateSchema(), (req, res) => res.json({ body: req.body }));

    const res = await request(app).post('/t').send({ anything: 'goes' });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ anything: 'goes' });
  });
});

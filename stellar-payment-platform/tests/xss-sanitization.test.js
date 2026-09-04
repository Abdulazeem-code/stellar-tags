'use strict';

/**
 * XSS sanitization tests (#491)
 *
 * Verifies that every free-text field in the Zod schemas strips HTML/JS tags
 * before data reaches the controller layer. Structured fields (Stellar
 * addresses, amounts, enums, numeric codes) are intentionally excluded — their
 * shape constraints already prohibit injection payloads, and sanitization would
 * break valid values.
 *
 * The test matrix covers:
 *  - The sanitizeString helper in isolation
 *  - registerBodySchema   → memo, memo_type
 *  - createApiKeyBodySchema → name, owner_id
 *  - revokeApiKeyBodySchema → revoked_by
 *  - rotateApiKeyBodySchema → name
 *  - paymentIntentSchema   → external_id, memo, memo_type
 */

const {
  sanitizeString,
  registerBodySchema,
  createApiKeyBodySchema,
  revokeApiKeyBodySchema,
  rotateApiKeyBodySchema,
} = require('../src/schemas');

const {
  paymentIntentSchema,
} = require('../src/schemas/paymentSchema');

// ---------------------------------------------------------------------------
// Common XSS payload fixtures
// ---------------------------------------------------------------------------

/** Payloads that must produce a sanitized (tag-stripped) output, not rejected. */
const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<a href="javascript:alert(1)">click</a>',
  '"><script>alert(document.cookie)</script>',
  "'; DROP TABLE users; --",                       // SQL, but also tests angle-bracket-free strings
  '<iframe src="evil.com"></iframe>',
  '<body onload=alert(1)>',
  '<input autofocus onfocus=alert(1)>',
  '<details open ontoggle=alert(1)>',
  '<!--<script>alert(1)</script>-->',
  '<style>body{background:url(javascript:alert(1))}</style>',
  // Encoded variants
  '&lt;script&gt;alert(1)&lt;/script&gt;',        // already-escaped — should pass through unchanged
];

/** Clean strings that must survive sanitization without modification. */
const CLEAN_VALUES = [
  'Hello World',
  'My API Key 2026',
  'user@example.com',                              // email-like owner_id
  'Payment for invoice #1234',
  "It's a great day",                              // apostrophe, no HTML
  'Amount: $100.00',
];

// ---------------------------------------------------------------------------
// Helper: parse a schema and return the value of one field from the result
// ---------------------------------------------------------------------------

const parseField = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Schema rejected input: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
};

// ---------------------------------------------------------------------------
// sanitizeString helper
// ---------------------------------------------------------------------------

describe('sanitizeString helper', () => {
  test.each(XSS_PAYLOADS)('strips tags from: %s', (payload) => {
    const output = sanitizeString(payload);
    expect(output).not.toMatch(/<script/i);
    expect(output).not.toMatch(/onerror/i);
    expect(output).not.toMatch(/onload/i);
    expect(output).not.toMatch(/onfocus/i);
    expect(output).not.toMatch(/ontoggle/i);
    expect(output).not.toMatch(/javascript:/i);
    expect(output).not.toMatch(/<iframe/i);
    expect(output).not.toMatch(/<style/i);
    expect(output).not.toMatch(/<svg/i);
    expect(output).not.toMatch(/<body/i);
    expect(output).not.toMatch(/<input/i);
    expect(output).not.toMatch(/<details/i);
    expect(output).not.toMatch(/<img/i);
    expect(output).not.toMatch(/<a /i);
  });

  test.each(CLEAN_VALUES)('preserves clean text: %s', (value) => {
    expect(sanitizeString(value)).toBe(value);
  });

  test('returns an empty string unchanged', () => {
    expect(sanitizeString('')).toBe('');
  });

  test('strips script tag and returns surrounding text', () => {
    const output = sanitizeString('before<script>alert(1)</script>after');
    expect(output).toBe('beforeafter');
  });

  test('strips nested/malformed tags', () => {
    const output = sanitizeString('<sc<script>ript>alert(1)</sc</script>ript>');
    expect(output).not.toMatch(/alert/);
  });
});

// ---------------------------------------------------------------------------
// registerBodySchema — memo and memo_type
// ---------------------------------------------------------------------------

describe('registerBodySchema XSS sanitization', () => {
  const BASE = { username: 'alice123', address: 'GABC123XYZ456789' };

  describe('memo field', () => {
    test.each(XSS_PAYLOADS)('sanitizes XSS payload in memo: %s', (payload) => {
      const data = parseField(registerBodySchema, { ...BASE, memo: payload, memo_type: 'text' });
      expect(data.memo).not.toMatch(/<script/i);
      expect(data.memo).not.toMatch(/onerror/i);
      expect(data.memo).not.toMatch(/javascript:/i);
    });

    test.each(CLEAN_VALUES)('preserves clean memo: %s', (value) => {
      const data = parseField(registerBodySchema, { ...BASE, memo: value });
      expect(data.memo).toBe(value);
    });

    test('allows memo to be absent', () => {
      const data = parseField(registerBodySchema, BASE);
      expect(data.memo).toBeUndefined();
    });
  });

  describe('memo_type field', () => {
    test.each(XSS_PAYLOADS)('sanitizes XSS payload in memo_type: %s', (payload) => {
      const data = parseField(registerBodySchema, { ...BASE, memo_type: payload });
      expect(data.memo_type).not.toMatch(/<script/i);
      expect(data.memo_type).not.toMatch(/onerror/i);
    });

    test.each(['text', 'id', 'hash'])('preserves standard memo_type: %s', (value) => {
      const data = parseField(registerBodySchema, { ...BASE, memo_type: value });
      expect(data.memo_type).toBe(value);
    });
  });
});

// ---------------------------------------------------------------------------
// createApiKeyBodySchema — name and owner_id
// ---------------------------------------------------------------------------

describe('createApiKeyBodySchema XSS sanitization', () => {
  const BASE = { name: 'My Key', owner_id: 'user-123' };

  describe('name field', () => {
    test.each(XSS_PAYLOADS)('sanitizes XSS payload in name: %s', (payload) => {
      // Payloads that are entirely tags may collapse to an empty string, which
      // fails min(1). Use a prefix to keep the field non-empty after stripping.
      const input = `Key: ${payload}`;
      const data = parseField(createApiKeyBodySchema, { ...BASE, name: input });
      expect(data.name).not.toMatch(/<script/i);
      expect(data.name).not.toMatch(/onerror/i);
      expect(data.name).not.toMatch(/javascript:/i);
    });

    test.each(CLEAN_VALUES)('preserves clean name: %s', (value) => {
      const data = parseField(createApiKeyBodySchema, { ...BASE, name: value });
      expect(data.name).toBe(value);
    });
  });

  describe('owner_id field', () => {
    test.each(XSS_PAYLOADS)('sanitizes XSS payload in owner_id: %s', (payload) => {
      const input = `owner: ${payload}`;
      const data = parseField(createApiKeyBodySchema, { ...BASE, owner_id: input });
      expect(data.owner_id).not.toMatch(/<script/i);
      expect(data.owner_id).not.toMatch(/onerror/i);
      expect(data.owner_id).not.toMatch(/javascript:/i);
    });

    test.each(CLEAN_VALUES)('preserves clean owner_id: %s', (value) => {
      const data = parseField(createApiKeyBodySchema, { ...BASE, owner_id: value });
      expect(data.owner_id).toBe(value);
    });
  });
});

// ---------------------------------------------------------------------------
// revokeApiKeyBodySchema — revoked_by
// ---------------------------------------------------------------------------

describe('revokeApiKeyBodySchema XSS sanitization', () => {
  describe('revoked_by field', () => {
    test.each(XSS_PAYLOADS)('sanitizes XSS payload in revoked_by: %s', (payload) => {
      const input = `admin: ${payload}`;
      const data = parseField(revokeApiKeyBodySchema, { revoked_by: input });
      expect(data.revoked_by).not.toMatch(/<script/i);
      expect(data.revoked_by).not.toMatch(/onerror/i);
      expect(data.revoked_by).not.toMatch(/javascript:/i);
    });

    test.each(CLEAN_VALUES)('preserves clean revoked_by: %s', (value) => {
      const data = parseField(revokeApiKeyBodySchema, { revoked_by: value });
      expect(data.revoked_by).toBe(value);
    });
  });
});

// ---------------------------------------------------------------------------
// rotateApiKeyBodySchema — name (optional)
// ---------------------------------------------------------------------------

describe('rotateApiKeyBodySchema XSS sanitization', () => {
  describe('name field', () => {
    test.each(XSS_PAYLOADS)('sanitizes XSS payload in name: %s', (payload) => {
      const input = `Rotated: ${payload}`;
      const data = parseField(rotateApiKeyBodySchema, { name: input });
      expect(data.name).not.toMatch(/<script/i);
      expect(data.name).not.toMatch(/onerror/i);
      expect(data.name).not.toMatch(/javascript:/i);
    });

    test.each(CLEAN_VALUES)('preserves clean name: %s', (value) => {
      const data = parseField(rotateApiKeyBodySchema, { name: value });
      expect(data.name).toBe(value);
    });

    test('allows name to be absent', () => {
      const data = parseField(rotateApiKeyBodySchema, {});
      expect(data.name).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// paymentIntentSchema — external_id, memo, memo_type
// ---------------------------------------------------------------------------

describe('paymentIntentSchema XSS sanitization', () => {
  const BASE = {
    from: 'GABC123',
    to: 'GDEF456',
    amount: '100',
  };

  describe('external_id field', () => {
    test.each(XSS_PAYLOADS)('sanitizes XSS payload in external_id: %s', (payload) => {
      const input = `id: ${payload}`;
      const data = parseField(paymentIntentSchema, { ...BASE, external_id: input });
      expect(data.external_id).not.toMatch(/<script/i);
      expect(data.external_id).not.toMatch(/onerror/i);
      expect(data.external_id).not.toMatch(/javascript:/i);
    });

    test.each(CLEAN_VALUES)('preserves clean external_id: %s', (value) => {
      const data = parseField(paymentIntentSchema, { ...BASE, external_id: value });
      expect(data.external_id).toBe(value);
    });

    test('allows external_id to be absent', () => {
      const data = parseField(paymentIntentSchema, BASE);
      expect(data.external_id).toBeUndefined();
    });
  });

  describe('memo field', () => {
    test.each(XSS_PAYLOADS)('sanitizes XSS payload in memo: %s', (payload) => {
      const input = `note: ${payload}`;
      const data = parseField(paymentIntentSchema, { ...BASE, memo: input });
      expect(data.memo).not.toMatch(/<script/i);
      expect(data.memo).not.toMatch(/onerror/i);
      expect(data.memo).not.toMatch(/javascript:/i);
    });

    test.each(CLEAN_VALUES)('preserves clean memo: %s', (value) => {
      const data = parseField(paymentIntentSchema, { ...BASE, memo: value });
      expect(data.memo).toBe(value);
    });
  });

  describe('memo_type field', () => {
    test.each(XSS_PAYLOADS)('sanitizes XSS payload in memo_type: %s', (payload) => {
      const input = `type: ${payload}`;
      const data = parseField(paymentIntentSchema, { ...BASE, memo_type: input });
      expect(data.memo_type).not.toMatch(/<script/i);
      expect(data.memo_type).not.toMatch(/onerror/i);
      expect(data.memo_type).not.toMatch(/javascript:/i);
    });

    test.each(['text', 'id', 'hash'])('preserves standard memo_type: %s', (type) => {
      const data = parseField(paymentIntentSchema, { ...BASE, memo_type: type });
      expect(data.memo_type).toBe(type);
    });
  });

  test('does not sanitize structured fields (from, to, amount, asset)', () => {
    // These are constrained by the handler; sanitization would corrupt valid values.
    const input = { ...BASE, asset: 'USDC:GBDDE...' };
    const data = parseField(paymentIntentSchema, input);
    expect(data.from).toBe(BASE.from);
    expect(data.to).toBe(BASE.to);
    expect(data.amount).toBe(BASE.amount);
    expect(data.asset).toBe('USDC:GBDDE...');
  });
});

// ---------------------------------------------------------------------------
// Integration: sanitized output flows through validateSchema middleware
// ---------------------------------------------------------------------------

describe('validateSchema middleware delivers sanitized output', () => {
  const express = require('express');
  const request = require('supertest');
  const { validateSchema } = require('../src/middleware/validateSchema');
  const { registerBodySchema: regSchema } = require('../src/schemas');

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/register',
      validateSchema({ body: regSchema }),
      (req, res) => res.json({ memo: req.body.memo, memo_type: req.body.memo_type }),
    );
    return app;
  };

  test('req.body contains sanitized memo after validateSchema runs', async () => {
    const res = await request(buildApp())
      .post('/register')
      .send({
        username: 'alice123',
        address: 'GABC123XYZ456789',
        memo: '<script>alert(1)</script>my note',
        memo_type: '<img onerror=x>text',
      });

    expect(res.status).toBe(200);
    expect(res.body.memo).not.toMatch(/<script/i);
    expect(res.body.memo).toBe('my note');
    expect(res.body.memo_type).not.toMatch(/onerror/i);
  });

  test('clean memo passes through validateSchema unchanged', async () => {
    const res = await request(buildApp())
      .post('/register')
      .send({
        username: 'bob456',
        address: 'GXYZ789ABC',
        memo: 'invoice-2026-001',
        memo_type: 'text',
      });

    expect(res.status).toBe(200);
    expect(res.body.memo).toBe('invoice-2026-001');
    expect(res.body.memo_type).toBe('text');
  });
});

'use strict';

const request = require('supertest');
const express = require('express');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: { isValidEd25519PublicKey: (value) => /^G[A-Z2-7]{55}$/.test(value || '') },
}));
jest.mock('../src/logger', () => ({ logger: require('pino')({ level: 'silent' }) }));
jest.mock('../prismaClient', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    paymentRequest: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  },
  isPrismaConnectionError: () => false,
}));
jest.mock('../src/services/ownershipService', () => ({ authenticateUsernameOwner: jest.fn() }));
jest.mock('../src/middleware/signatureRateLimit', () => ({
  createSignatureRateLimiter: () => (req, res, next) => next(),
}));

// qrcode renders far slower inside Jest's sandbox than in Node (about 2.5s vs
// 60ms for 1024px), so route tests stick to small images and the size clamp is
// checked on the schema. The longer timeout is headroom for slow CI runners.
jest.setTimeout(20000);

const { prisma } = require('../prismaClient');
const { paymentRequestQrQuerySchema } = require('../src/schemas');
const { buildErrorHandler } = require('../src/middleware/errorHandler');
const buildRouter = require('../src/routes/v1/paymentRequestRoutes');

const DESTINATION = `G${'A'.repeat(55)}`;
const pending = {
  id: 'req-qr-1',
  tag: 'alice*localhost',
  destination: DESTINATION,
  amount: '12.5',
  asset: 'XLM',
  memoType: 'text',
  memo: 'invoice-9',
  status: 'pending',
  expiresAt: new Date(Date.now() + 86400000),
};

const app = express()
  .use('/', buildRouter(null))
  .use(buildErrorHandler(() => false));

// supertest buffers image/png but not image/svg+xml, so collect raw bytes.
const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

// Width from the IHDR chunk; avoids decoding large images just to check size.
const pngWidth = (buffer) => buffer.readUInt32BE(16);

const decodePng = (buffer) => {
  const png = PNG.sync.read(buffer);
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return { text: result?.data, width: png.width };
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PAY_PAGE_URL;
  delete process.env.PUBLIC_API_URL;
  delete process.env.DOMAIN;
  prisma.paymentRequest.findUnique.mockResolvedValue(pending);
});

describe('GET /payment-requests/:id/qr.(png|svg)', () => {
  test('PNG encodes the HTTPS pay link by default', async () => {
    process.env.PUBLIC_API_URL = 'https://pay.example.com';
    const res = await request(app).get('/payment-requests/req-qr-1/qr.png').buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(pngWidth(res.body)).toBe(512);

    // Decode a small copy: jsqr on a 512px image is slow under coverage.
    const small = await request(app).get('/payment-requests/req-qr-1/qr.png?size=200').buffer(true).parse(binary);
    const { text, width } = decodePng(small.body);
    expect(width).toBe(200);
    const link = new URL(text);
    expect(link.origin + link.pathname).toBe('https://pay.example.com/pay/alice');
    expect(link.searchParams.get('amount')).toBe('12.5');
    expect(link.searchParams.get('memo')).toBe('invoice-9');
    expect(link.searchParams.get('requestId')).toBe('req-qr-1');
  });

  test('PAY_PAGE_URL points the pay link at the dashboard, ahead of PUBLIC_API_URL', async () => {
    process.env.PAY_PAGE_URL = 'https://app.example.com';
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    const res = await request(app).get('/payment-requests/req-qr-1/qr.svg');
    expect(res.status).toBe(200);
    const small = await request(app).get('/payment-requests/req-qr-1/qr.png?size=200').buffer(true).parse(binary);
    const link = new URL(decodePng(small.body).text);
    expect(link.origin).toBe('https://app.example.com');
    expect(link.pathname).toBe('/pay/alice');
  });

  test('format=sep7 encodes the web+stellar:pay URI', async () => {
    const res = await request(app)
      .get('/payment-requests/req-qr-1/qr.png?format=sep7&size=200')
      .buffer(true)
      .parse(binary);

    expect(res.status).toBe(200);
    const { text } = decodePng(res.body);
    expect(text.startsWith('web+stellar:pay?')).toBe(true);
    const params = new URLSearchParams(text.slice('web+stellar:pay?'.length));
    expect(params.get('destination')).toBe(DESTINATION);
    expect(params.get('amount')).toBe('12.5');
    expect(params.get('memo')).toBe('invoice-9');
  });

  test('SVG returns image/svg+xml', async () => {
    const res = await request(app).get('/payment-requests/req-qr-1/qr.svg').buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    const svg = res.body.toString('utf8');
    expect(svg).toMatch(/^<svg[^>]+width="512"/);
  });

  test.each([
    ['64', 128],
    ['5000', 1024],
    ['300', 300],
    ['abc', 512],
    [undefined, 512],
  ])('schema clamps size=%s to %i', (size, expected) => {
    expect(paymentRequestQrQuerySchema.parse({ size }).size).toBe(expected);
  });

  test.each([
    ['64', 128],
    ['300', 300],
  ])('PNG for size=%s is %i px wide', async (size, expected) => {
    const res = await request(app)
      .get(`/payment-requests/req-qr-1/qr.png?size=${size}`)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(pngWidth(res.body)).toBe(expected);
  });

  test('unknown id returns 404', async () => {
    prisma.paymentRequest.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/payment-requests/missing/qr.png');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('bad format returns 400', async () => {
    const res = await request(app).get('/payment-requests/req-qr-1/qr.svg?format=bitcoin');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(prisma.paymentRequest.findUnique).not.toHaveBeenCalled();
  });

  test.each([
    ['paid', { status: 'paid' }],
    ['cancelled', { status: 'cancelled' }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('%s requests are served with no-store', async (_label, override) => {
    prisma.paymentRequest.findUnique.mockResolvedValue({ ...pending, ...override });
    const res = await request(app).get('/payment-requests/req-qr-1/qr.svg');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

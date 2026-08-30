const express = require('express');
const request = require('supertest');

const mockPaymentIntentCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    paymentIntent: { create: mockPaymentIntentCreate },
    $transaction: mockTransaction,
  },
}));

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    isValidEd25519PublicKey: jest.fn(() => true),
  },
}));

const paymentRoutes = require('../src/routes/v1/paymentRoutes');
const {
  paymentIntentSchema,
  MAX_METADATA_BYTES,
} = require('../src/schemas/paymentSchema');
const { dispatchPaymentWebhooks } = require('../src/webhookWorker');

const baseIntent = {
  external_id: 'order-123',
  from: 'GSOURCE',
  to: 'GDESTINATION',
  amount: '25.00',
};

describe('payment intent metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('accepts JSON metadata whose serialized size is exactly 2KB', () => {
    const emptyObjectBytes = Buffer.byteLength(JSON.stringify({ value: '' }), 'utf8');
    const metadata = { value: 'a'.repeat(MAX_METADATA_BYTES - emptyObjectBytes) };

    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBe(MAX_METADATA_BYTES);
    expect(paymentIntentSchema.safeParse({ ...baseIntent, metadata }).success).toBe(true);
  });

  test('rejects metadata larger than 2KB', () => {
    const emptyObjectBytes = Buffer.byteLength(JSON.stringify({ value: '' }), 'utf8');
    const metadata = { value: 'a'.repeat(MAX_METADATA_BYTES - emptyObjectBytes + 1) };
    const result = paymentIntentSchema.safeParse({ ...baseIntent, metadata });

    expect(result.success).toBe(false);
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ['metadata'],
        message: 'metadata must not exceed 2KB',
      }),
    ]));
  });

  test('measures metadata as UTF-8 bytes', () => {
    const metadata = { customer: '€'.repeat(700) };

    expect(JSON.stringify(metadata).length).toBeLessThan(MAX_METADATA_BYTES);
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBeGreaterThan(MAX_METADATA_BYTES);
    expect(paymentIntentSchema.safeParse({ ...baseIntent, metadata }).success).toBe(false);
  });

  test('rejects non-object metadata', () => {
    expect(paymentIntentSchema.safeParse({ ...baseIntent, metadata: ['order-123'] }).success).toBe(false);
  });

  test('persists metadata from the bulk payment endpoint', async () => {
    const metadata = { order_id: 'order-123', customer_id: 'customer-456' };
    mockPaymentIntentCreate.mockImplementation(({ data }) => Promise.resolve({
      id: 'intent-1',
      externalId: data.externalId,
      metadata: data.metadata,
    }));
    mockTransaction.mockImplementation((operations) => Promise.all(operations));

    const app = express();
    app.use(express.json());
    app.use('/v1', paymentRoutes(null));

    const response = await request(app)
      .post('/v1/payments/bulk')
      .send([{ ...baseIntent, metadata }]);

    expect(response.status).toBe(201);
    expect(mockPaymentIntentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata }),
    });
  });

  test('includes metadata in payment webhook data', async () => {
    const metadata = { order_id: 'order-123', customer_id: 'customer-456' };
    const prisma = {
      webhook: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'webhook-1',
          url: 'https://merchant.example/webhooks',
          secret: 'secret',
        }]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

    await dispatchPaymentWebhooks({
      prisma,
      poolGetFn: jest.fn(),
      poolRunFn: jest.fn(),
      payment: {
        id: 'payment-1',
        type: 'payment',
        transaction_hash: 'transaction-1',
        from: 'GSOURCE',
        to: 'GDESTINATION',
        amount: '25.00',
        asset_type: 'native',
        metadata,
      },
    });

    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.data.metadata).toEqual(metadata);
  });

  test('delivers payment events only when the merchant subscribed to payment.received', async () => {
    const prisma = {
      webhook: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'webhook-1',
          url: 'https://merchant.example/webhooks',
          secret: 'secret',
          events: ['payment.received'],
        }]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

    await dispatchPaymentWebhooks({
      prisma,
      poolGetFn: jest.fn(),
      poolRunFn: jest.fn(),
      payment: {
        id: 'payment-2',
        type: 'payment',
        transaction_hash: 'transaction-2',
        from: 'GSOURCE',
        to: 'GDESTINATION',
        amount: '25.00',
        asset_type: 'native',
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.event).toBe('payment.received');
  });

  test('skips delivery for unsubscribed webhook event types', async () => {
    const prisma = {
      webhook: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'webhook-1',
          url: 'https://merchant.example/webhooks',
          secret: 'secret',
          events: ['registration.updated'],
        }]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

    await dispatchPaymentWebhooks({
      prisma,
      poolGetFn: jest.fn(),
      poolRunFn: jest.fn(),
      payment: {
        id: 'payment-3',
        type: 'payment',
        transaction_hash: 'transaction-3',
        from: 'GSOURCE',
        to: 'GDESTINATION',
        amount: '25.00',
        asset_type: 'native',
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

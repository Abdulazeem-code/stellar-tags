'use strict';

const {
  createPaymentWithOutbox,
  updatePaymentWithOutbox,
  processOutboxBatch,
} = require('../src/services/settlementOutbox');
const { createRabbitOutboxPublisher } = require('../src/services/rabbitOutboxPublisher');

const PAYMENT = {
  id: 'pay-1',
  status: 'completed',
  fromAddress: 'GSENDER',
  toAddress: 'GRECEIVER',
  amount: 2.5,
  assetCode: 'XLM',
  transactionHash: 'tx-hash',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function mockDb() {
  const tx = {
    payment: {
      create: jest.fn(async () => PAYMENT),
      update: jest.fn(async () => ({ ...PAYMENT, status: 'failed' })),
    },
    outboxMessage: { create: jest.fn(async ({ data }) => ({ id: 'outbox-1', ...data })) },
  };
  return { tx, db: { $transaction: jest.fn(async (callback) => callback(tx)) } };
}

describe('payment changes are atomically enqueued', () => {
  it('uses the same Prisma transaction for payment creation and event insertion', async () => {
    const { tx, db } = mockDb();
    const payment = await createPaymentWithOutbox(db, { fromAddress: 'GSENDER', toAddress: 'GRECEIVER', amount: 2.5 });
    expect(payment).toBe(PAYMENT);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.payment.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxMessage.create).toHaveBeenCalledWith({
      data: {
        eventType: 'payment.created',
        payload: expect.objectContaining({
          paymentId: 'pay-1', status: 'completed', amount: 2.5,
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
  });

  it('uses the same transaction for payment updates', async () => {
    const { tx, db } = mockDb();
    await updatePaymentWithOutbox(db, 'pay-1', { status: 'failed' });
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 'pay-1' }, data: { status: 'failed' } });
    expect(tx.outboxMessage.create).toHaveBeenCalledWith({
      data: { eventType: 'payment.updated', payload: expect.objectContaining({ status: 'failed' }) },
    });
  });

  it('propagates outbox write errors (never returns false success)', async () => {
    const { tx, db } = mockDb();
    tx.outboxMessage.create.mockRejectedValue(new Error('outbox insert failed'));
    await expect(createPaymentWithOutbox(db, {})).rejects.toThrow('outbox insert failed');
  });
});

describe('RabbitMQ persistent publishing', () => {
  const message = { id: 'msg-1', eventType: 'payment.created', payload: { paymentId: 'pay-1' } };

  it('sends a persistent, deduplicatable message through the exchange', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ routed: true }) });
    const publisher = createRabbitOutboxPublisher({
      url: 'http://localhost:15672', username: 'user', password: 'secret', fetchImpl,
    });
    await publisher(message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url.pathname).toContain('/api/exchanges/%2F/payment.events/publish');
    expect(request.method).toBe('POST');
    const body = JSON.parse(request.body);
    expect(body.properties).toEqual(expect.objectContaining({
      message_id: message.id,
      delivery_mode: 2,
      content_type: 'application/json',
    }));
    expect(JSON.parse(body.payload)).toEqual(expect.objectContaining({ id: 'msg-1', eventType: 'payment.created' }));
  });

  it('treats unrouted RabbitMQ messages as failures', async () => {
    const publisher = createRabbitOutboxPublisher({
      url: 'http://localhost:15672', username: 'u', password: 'p',
      fetchImpl: async () => ({ ok: true, json: async () => ({ routed: false }) }),
    });
    await expect(publisher(message)).rejects.toThrow('not routed');
  });
});

describe('retryable processing', () => {
  it('keeps a failed outbox row eligible after backoff and publishes after recovery', async () => {
    const row = {
      id: 'msg-1', eventType: 'payment.created', payload: { paymentId: 'pay-1' },
      status: 'PENDING', retries: 0,
      nextAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
      lockedUntil: null, lockOwner: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const db = {
      outboxMessage: {
        findMany: jest.fn(async ({ where }) => row.status !== 'PROCESSED' && row.nextAttemptAt <= where.nextAttemptAt.lte ? [{ ...row }] : []),
        updateMany: jest.fn(async ({ where, data }) => {
          if (where.lockOwner && row.lockOwner !== where.lockOwner) return { count: 0 };
          if (!where.lockOwner && row.lockOwner) return { count: 0 };
          for (const [key, value] of Object.entries(data)) {
            row[key] = value && typeof value === 'object' && 'increment' in value
              ? row[key] + value.increment : value;
          }
          return { count: 1 };
        }),
      },
    };
    let current = new Date('2026-01-01T00:00:02.000Z');
    const now = () => current;
    const outage = await processOutboxBatch({
      prismaClient: db, now, publisher: async () => { throw new Error('broker unavailable'); },
    });
    expect(outage).toEqual({ claimed: 1, processed: 0, failed: 1 });
    expect(row.status).toBe('FAILED');
    expect(row.retries).toBe(1);
    const delivered = jest.fn();
    current = new Date('2026-01-01T00:00:04.000Z');
    const recovered = await processOutboxBatch({ prismaClient: db, now, publisher: delivered });
    expect(recovered).toEqual({ claimed: 1, processed: 1, failed: 0 });
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }));
    expect(row.status).toBe('PROCESSED');
    expect(row.processedAt).toBeInstanceOf(Date);
  });
});

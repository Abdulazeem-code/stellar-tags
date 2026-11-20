'use strict';

// Real PostgreSQL, fake broker: a network outage must not erase a committed
// notification. Global setup deploys the real Prisma migration chain.
const { prisma, resetTestState } = require('./support/harness');
const {
  createPaymentWithOutbox,
  updatePaymentWithOutbox,
  processOutboxBatch,
} = require('../../src/services/settlementOutbox');
const { appendEvent, PaymentEventTypes } = require('../../src/services/eventStore');

const sample = {
  fromAddress: 'GFROM',
  toAddress: 'GTO',
  amount: 4.25,
  assetCode: 'XLM',
  status: 'pending',
};

describe('transactional outbox (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetTestState();
  });

  it('commits an outbox record with payment; retries after broker outage', async () => {
    const db = prisma();
    const payment = await createPaymentWithOutbox(db, sample);
    const pending = await db.outboxMessage.findFirst();
    expect(pending).toMatchObject({
      eventType: 'payment.created',
      status: 'PENDING', retries: 0,
      payload: expect.objectContaining({ paymentId: payment.id, status: 'pending' }),
    });

    const outage = await processOutboxBatch({
      prismaClient: db,
      publisher: async () => { throw new Error('RabbitMQ temporarily offline'); },
    });
    expect(outage).toEqual({ claimed: 1, processed: 0, failed: 1 });
    const failed = await db.outboxMessage.findUnique({ where: { id: pending.id } });
    expect(failed).toMatchObject({ status: 'FAILED', retries: 1 });
    expect(await db.payment.findUnique({ where: { id: payment.id } })).not.toBeNull();

    // Advance backoff without sleeping, then restore the broker.
    await db.outboxMessage.update({
      where: { id: pending.id },
      data: { nextAttemptAt: new Date(0) },
    });
    const received = [];
    const recovery = await processOutboxBatch({
      prismaClient: db,
      publisher: async (message) => received.push(message),
    });
    expect(recovery).toEqual({ claimed: 1, processed: 1, failed: 0 });
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(pending.id);
    expect((await db.outboxMessage.findUnique({ where: { id: pending.id } })).status).toBe('PROCESSED');
  });

  it('rolls back payment creation if inserting outbox notification fails', async () => {
    const db = prisma();
    const broken = {
      $transaction: (callback) => db.$transaction(async (tx) => callback({
        payment: tx.payment,
        outboxMessage: { create: async () => { throw new Error('outbox DB write failed'); } },
      })),
    };
    await expect(createPaymentWithOutbox(broken, sample)).rejects.toThrow('outbox DB write failed');
    expect(await db.payment.count()).toBe(0);
    expect(await db.outboxMessage.count()).toBe(0);
  });

  it('records both payment updates and domain state events transactionally', async () => {
    const db = prisma();
    const payment = await createPaymentWithOutbox(db, sample);
    await updatePaymentWithOutbox(db, payment.id, { status: 'completed' });
    expect(await db.outboxMessage.count()).toBe(2);
    expect((await db.outboxMessage.findFirst({ where: { eventType: 'payment.updated' } })).payload.status).toBe('completed');

    const event = await appendEvent({
      paymentId: payment.id,
      eventType: PaymentEventTypes.PAYMENT_COMPLETED,
      data: {},
    });
    const notification = await db.outboxMessage.findFirst({ where: { eventType: PaymentEventTypes.PAYMENT_COMPLETED } });
    expect(notification.payload).toMatchObject({ paymentId: payment.id, eventId: event.id, sequence: 1 });
  });
});

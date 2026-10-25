'use strict';

/**
 * Unit tests for the stale-pending ledger reconciliation added to
 * src/reconciliation-cron.js (issue #933).
 *
 * Horizon responses are mocked at the stellarService boundary and the event
 * store is mocked so we can assert the settlement events dispatched after a
 * PENDING -> SUCCESS / FAILED transition.
 */

jest.mock(
  'node-cron',
  () => ({
    schedule: jest.fn(),
  }),
  { virtual: true },
);

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../src/services/stellarService', () => ({
  fetchTransaction: jest.fn(),
  fetchPaymentsForTransaction: jest.fn(),
  fetchPaymentsForAccount: jest.fn(),
}));

jest.mock('../src/services/eventStore', () => ({
  PaymentEventTypes: {
    PAYMENT_CREATED: 'PAYMENT_CREATED',
    PAYMENT_VALIDATED: 'PAYMENT_VALIDATED',
    PAYMENT_ROUTED: 'PAYMENT_ROUTED',
    PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',
    PAYMENT_FAILED: 'PAYMENT_FAILED',
    PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
    PAYMENT_FLAGGED_FRAUD: 'PAYMENT_FLAGGED_FRAUD',
    PAYMENT_CLEARED_FRAUD: 'PAYMENT_CLEARED_FRAUD',
  },
  appendEvent: jest.fn().mockResolvedValue({ id: 'evt_1' }),
}));

const cron = require('node-cron');
const {
  fetchTransaction,
  fetchPaymentsForAccount,
} = require('../src/services/stellarService');
const { appendEvent } = require('../src/services/eventStore');
const {
  runStalePendingReconciliation,
  scheduleLedgerReconciliationJob,
  STALE_PENDING_MINUTES,
  FAIL_AFTER_MINUTES,
  RECONCILE_CRON,
  PENDING_STATUSES,
  RECONCILED_STATUS,
} = require('../src/reconciliation-cron');

function makePayment(overrides = {}) {
  return {
    id: 'pay_1',
    fromAddress: 'GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
    toAddress: 'GTOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2',
    amount: 100,
    assetCode: null,
    transactionHash: 'HASH123',
    status: 'pending',
    createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min stale
    deletedAt: null,
    ...overrides,
  };
}

function makePrisma(payments) {
  return {
    payment: {
      findMany: jest.fn().mockResolvedValue(payments),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  appendEvent.mockResolvedValue({ id: 'evt_1' });
});

describe('runStalePendingReconciliation scan', () => {
  it('scans stale pending payments with a 5-minute cutoff', async () => {
    const prisma = makePrisma([]);
    const result = await runStalePendingReconciliation(prisma);

    const where = prisma.payment.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(PENDING_STATUSES);
    expect(where.deletedAt).toBeNull();
    expect(where.createdAt.lte).toBeInstanceOf(Date);
    expect(Date.now() - where.createdAt.lte.getTime())
      .toBeGreaterThanOrEqual(STALE_PENDING_MINUTES * 60 * 1000 - 1000);
    expect(result.scanned).toBe(0);
  });
});

describe('reconciliation by transaction hash', () => {
  it('moves a payment from PENDING to SUCCESS and dispatches PAYMENT_COMPLETED', async () => {
    fetchTransaction.mockResolvedValue({ hash: 'HASH123', successful: true });
    const prisma = makePrisma([makePayment()]);

    const result = await runStalePendingReconciliation(prisma);

    expect(fetchTransaction).toHaveBeenCalledWith('HASH123');
    expect(result.confirmed).toBe(1);

    const update = prisma.payment.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'pay_1', status: { in: PENDING_STATUSES } });
    expect(update.data.status).toBe(RECONCILED_STATUS.SUCCESS);

    expect(appendEvent).toHaveBeenCalledTimes(1);
    const evt = appendEvent.mock.calls[0][0];
    expect(evt.eventType).toBe('PAYMENT_COMPLETED');
    expect(evt.paymentId).toBe('pay_1');
    expect(evt.data.previousStatus).toBe('pending');
    expect(evt.data.status).toBe('SUCCESS');
    expect(evt.metadata.source).toBe('reconciliation-cron');
  });

  it('moves a payment to FAILED when the on-chain transaction was unsuccessful', async () => {
    fetchTransaction.mockResolvedValue({ hash: 'HASH123', successful: false });
    const prisma = makePrisma([makePayment()]);

    const result = await runStalePendingReconciliation(prisma);

    expect(result.failed).toBe(1);
    expect(prisma.payment.updateMany.mock.calls[0][0].data.status)
      .toBe(RECONCILED_STATUS.FAILED);
    expect(appendEvent.mock.calls[0][0].eventType).toBe('PAYMENT_FAILED');
  });

  it('keeps the payment pending on a 404 inside the fail-after window', async () => {
    const err = new Error('Not Found');
    err.response = { status: 404 };
    fetchTransaction.mockRejectedValue(err);
    const prisma = makePrisma([makePayment()]);

    const result = await runStalePendingReconciliation(prisma);

    expect(result.pending).toBe(1);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('hard-fails a payment whose hash never appears on chain past the fail-after window', async () => {
    const err = new Error('Not Found');
    err.response = { status: 404 };
    fetchTransaction.mockRejectedValue(err);
    const veryOld = new Date(Date.now() - (FAIL_AFTER_MINUTES + 30) * 60 * 1000);
    const prisma = makePrisma([makePayment({ createdAt: veryOld })]);

    const result = await runStalePendingReconciliation(prisma);

    expect(result.failed).toBe(1);
    expect(prisma.payment.updateMany.mock.calls[0][0].data.status)
      .toBe(RECONCILED_STATUS.FAILED);
    expect(appendEvent.mock.calls[0][0].eventType).toBe('PAYMENT_FAILED');
  });

  it('skips the payment without touching the DB when the circuit breaker is open', async () => {
    const err = new Error('Breaker is open');
    err.name = 'CircuitBreakerOpenError';
    fetchTransaction.mockRejectedValue(err);
    const prisma = makePrisma([makePayment()]);

    const result = await runStalePendingReconciliation(prisma);

    expect(result.skipped).toBe(1);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it('does not dispatch an event when the guarded update matched no row', async () => {
    fetchTransaction.mockResolvedValue({ hash: 'HASH123', successful: true });
    const prisma = makePrisma([makePayment()]);
    prisma.payment.updateMany.mockResolvedValue({ count: 0 }); // listener got there first

    await runStalePendingReconciliation(prisma);

    expect(appendEvent).not.toHaveBeenCalled();
  });
});

describe('reconciliation by memo / payment reference', () => {
  it('matches an on-chain payment by memo and persists its transaction hash', async () => {
    const payment = makePayment({ transactionHash: null, memo: 'ORDER-42' });
    fetchPaymentsForAccount.mockResolvedValue({
      records: [
        {
          type: 'payment',
          from: 'GCOUNTERNOP',
          to: payment.toAddress,
          amount: '100.0000000',
          memo: 'OTHER',
          transaction_hash: 'TX_ONCHAIN_1',
        },
        {
          type: 'payment',
          from: payment.fromAddress,
          to: payment.toAddress,
          amount: '100.0000000',
          memo: 'ORDER-42',
          transaction_hash: 'TX_ONCHAIN_2',
        },
      ],
    });
    const prisma = makePrisma([payment]);

    const result = await runStalePendingReconciliation(prisma);

    expect(fetchPaymentsForAccount).toHaveBeenCalledWith({
      address: payment.toAddress,
      limit: 50,
      order: 'desc',
    });
    expect(result.confirmed).toBe(1);
    const update = prisma.payment.updateMany.mock.calls[0][0];
    expect(update.data.status).toBe(RECONCILED_STATUS.SUCCESS);
    expect(update.data.transactionHash).toBe('TX_ONCHAIN_2');
    expect(appendEvent.mock.calls[0][0].eventType).toBe('PAYMENT_COMPLETED');
  });

  it('leaves the payment pending when no on-chain payment matches', async () => {
    const payment = makePayment({ transactionHash: null });
    fetchPaymentsForAccount.mockResolvedValue({ records: [] });
    const prisma = makePrisma([payment]);

    const result = await runStalePendingReconciliation(prisma);

    expect(result.pending).toBe(1);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });
});

describe('scheduleLedgerReconciliationJob', () => {
  it('registers a cron that runs every 5 minutes', () => {
    const prisma = makePrisma([]);
    scheduleLedgerReconciliationJob(prisma);

    expect(cron.schedule).toHaveBeenCalledWith(RECONCILE_CRON, expect.any(Function));
    expect(RECONCILE_CRON).toBe('*/5 * * * *');
  });

  it('runs a reconciliation pass when the cron fires', async () => {
    const prisma = makePrisma([]);
    scheduleLedgerReconciliationJob(prisma);
    const task = cron.schedule.mock.calls[0][1];

    await task();

    expect(prisma.payment.findMany).toHaveBeenCalled();
  });
});

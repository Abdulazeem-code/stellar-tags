'use strict';

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock('../src/metrics', () => ({
  paymentRequestsPaidTotal: { inc: jest.fn() },
}));
jest.mock('../src/services/stellarService', () => ({
  fetchTransaction: jest.fn(),
}));

const { logger } = require('../src/logger');
const { fetchTransaction } = require('../src/services/stellarService');
const { paymentRequestsPaidTotal } = require('../src/metrics');
const { matchPayment } = require('../src/services/paymentRequestMatcher');

const baseRequest = {
  id: 'request-1',
  destination: 'GDEST',
  amount: '10.0000000',
  asset: 'XLM',
  memo: 'invoice-42',
  status: 'pending',
  expiresAt: new Date(Date.now() + 86400000),
};

const payment = {
  to: 'GDEST',
  amount: '10',
  asset_type: 'native',
  transaction_hash: 'tx-123',
};

const buildPrisma = (requests, updateImplementation) => ({
  paymentRequest: {
    findMany: jest.fn().mockResolvedValue(requests),
    updateMany: jest.fn(updateImplementation || (() => Promise.resolve({ count: 1 }))),
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchTransaction.mockResolvedValue({ memo: 'invoice-42' });
});

describe('matchPayment', () => {
  test('matches exact payment', async () => {
    const prisma = buildPrisma([baseRequest]);
    await expect(matchPayment(prisma, payment)).resolves.toEqual(['request-1']);
    expect(prisma.paymentRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'request-1', status: 'pending' },
      data: expect.objectContaining({
        status: 'paid',
        transactionHash: 'tx-123',
      }),
    });
    expect(paymentRequestsPaidTotal.inc).toHaveBeenCalledTimes(1);
  });

  test('matches overpayment using decimal precision', async () => {
    const prisma = buildPrisma([{ ...baseRequest, amount: '9.9999999' }]);
    await matchPayment(prisma, { ...payment, amount: '10.0000001' });
    expect(prisma.paymentRequest.updateMany).toHaveBeenCalled();
  });

  test('does not match underpayment', async () => {
    const prisma = buildPrisma([baseRequest]);
    await matchPayment(prisma, { ...payment, amount: '9.9999999' });
    expect(prisma.paymentRequest.updateMany).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  test('does not match wrong asset', async () => {
    const prisma = buildPrisma([baseRequest]);
    await matchPayment(prisma, {
      ...payment,
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GISSUER',
    });
    expect(prisma.paymentRequest.updateMany).not.toHaveBeenCalled();
  });

  test('does not match wrong memo', async () => {
    fetchTransaction.mockResolvedValue({ memo: 'wrong-memo' });
    const prisma = buildPrisma([baseRequest]);
    await matchPayment(prisma, payment);
    expect(prisma.paymentRequest.updateMany).not.toHaveBeenCalled();
  });

  test('does not match expired or cancelled requests', async () => {
    const prisma = buildPrisma([
      { ...baseRequest, expiresAt: new Date(Date.now() - 1000) },
      { ...baseRequest, id: 'cancelled', status: 'cancelled' },
    ]);
    await matchPayment(prisma, payment);
    expect(fetchTransaction).not.toHaveBeenCalled();
    expect(prisma.paymentRequest.updateMany).not.toHaveBeenCalled();
  });

  test('duplicate event is idempotent', async () => {
    let transitionCount = 0;
    const prisma = buildPrisma([baseRequest], () => {
      transitionCount += 1;
      return Promise.resolve({ count: transitionCount === 1 ? 1 : 0 });
    });
    await matchPayment(prisma, payment);
    await matchPayment(prisma, payment);
    expect(paymentRequestsPaidTotal.inc).toHaveBeenCalledTimes(1);
  });

  test('concurrent calls produce one paid transition', async () => {
    let transitionCount = 0;
    const prisma = buildPrisma([baseRequest], () => {
      transitionCount += 1;
      return Promise.resolve({ count: transitionCount === 1 ? 1 : 0 });
    });
    const [first, second] = await Promise.all([
      matchPayment(prisma, payment),
      matchPayment(prisma, payment),
    ]);
    expect(first.length + second.length).toBe(1);
  });

  test('skips Horizon when destination has no pending requests', async () => {
    const prisma = buildPrisma([]);
    await matchPayment(prisma, payment);
    expect(fetchTransaction).not.toHaveBeenCalled();
  });

  test('transaction fetch failure is logged and does not crash', async () => {
    fetchTransaction.mockRejectedValue(new Error('Horizon unavailable'));
    const prisma = buildPrisma([baseRequest]);
    await expect(matchPayment(prisma, payment)).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });
});

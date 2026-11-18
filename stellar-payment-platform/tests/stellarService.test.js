'use strict';

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('@stellar/stellar-sdk', () => {
  const mockCallFn = jest.fn();
  const mockPaymentsForTransaction = jest.fn().mockReturnValue({ call: mockCallFn });
  const mockPayments = jest.fn().mockReturnValue({
    forAccount: jest.fn().mockReturnValue({
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      cursor: jest.fn().mockReturnThis(),
      call: mockCallFn,
    }),
    forTransaction: mockPaymentsForTransaction,
  });
  const mockTransactionCall = jest.fn();
  const mockTransactions = jest.fn().mockReturnValue({
    transaction: jest.fn().mockReturnValue({ call: mockTransactionCall }),
  });
  const mockLedgersCall = jest.fn();
  const mockLedgers = jest.fn().mockReturnValue({ latest: jest.fn().mockReturnValue({ call: mockLedgersCall }) });

  const mockServerInstance = {
    loadAccount: jest.fn(),
    payments: mockPayments,
    transactions: mockTransactions,
    ledgers: mockLedgers,
  };

  const Horizon = {
    Server: jest.fn().mockReturnValue(mockServerInstance),
  };

  return {
    Horizon,
    __mockServer: mockServerInstance,
    __mockCallFn: mockCallFn,
    __mockTransactionCall: mockTransactionCall,
    __mockLedgersCall: mockLedgersCall,
  };
});

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  httpLogger: (req, res, next) => next(),
}));

const { __mockServer, __mockCallFn, __mockTransactionCall } = require('@stellar/stellar-sdk');
const {
  loadAccount,
  fetchTransaction,
  fetchPaymentsForTransaction,
  fetchPaymentsForAccount,
  fetchFirstPaymentsPage,
  wrapPageWithBreaker,
  createBreaker,
  submitTransactionWithRetry,
  isRetryableSubmissionError,
  computeBackoff,
  HORIZON_BASE,
  BREAKER_THRESHOLD,
} = require('../src/services/stellarService');

describe('StellarService — Circuit Breaker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('configuration', () => {
    it('exports HORIZON_BASE from env or default', () => {
      expect(typeof HORIZON_BASE).toBe('string');
      expect(HORIZON_BASE).toMatch(/^https?:\/\//);
    });

    it('exports BREAKER_THRESHOLD as a number', () => {
      expect(typeof BREAKER_THRESHOLD).toBe('number');
      expect(BREAKER_THRESHOLD).toBeGreaterThan(0);
    });
  });

  describe('createBreaker', () => {
    it('creates a circuit breaker that passes through results', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const breaker = createBreaker(fn, {
        timeout: 1000,
        volumeThreshold: 1,
        errorThresholdPercentage: 1,
        resetTimeout: 1000,
      });

      const result = await breaker.fire();
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('trips open after configured volume threshold failures', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const breaker = createBreaker(fn, {
        timeout: 1000,
        volumeThreshold: 2,
        errorThresholdPercentage: 1,
        resetTimeout: 60000,
      });

      for (let i = 0; i < 2; i++) {
        try { await breaker.fire(); } catch (_e) { /* trip breaker */ }
      }

      expect(breaker.opened).toBe(true);

      const callsBefore = fn.mock.calls.length;
      await expect(breaker.fire()).rejects.toThrow();
      expect(fn.mock.calls.length).toBe(callsBefore);
    });

    it('wraps errors as CircuitBreakerOpenError when open', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const breaker = createBreaker(fn, {
        timeout: 1000,
        volumeThreshold: 2,
        errorThresholdPercentage: 1,
        resetTimeout: 60000,
      });

      for (let i = 0; i < 2; i++) {
        try { await breaker.fire(); } catch (_e) { /* trip breaker */ }
      }

      try {
        await breaker.fire();
        throw new Error('Expected error to be thrown');
      } catch (err) {
        expect(err.code).toBe('EOPENBREAKER');
      }
    });

    it('recovers after resetTimeout', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('recovered');

      const breaker = createBreaker(fn, {
        timeout: 1000,
        volumeThreshold: 2,
        errorThresholdPercentage: 1,
        resetTimeout: 50, // very short for testing
      });

      for (let i = 0; i < 2; i++) {
        try { await breaker.fire(); } catch (_e) { /* trip breaker */ }
      }
      expect(breaker.opened).toBe(true);

      // Wait for reset timeout to allow halfOpen
      await new Promise((r) => setTimeout(r, 100));

      const result = await breaker.fire();
      expect(result).toBe('recovered');
      expect(breaker.opened).toBe(false);
    });
  });

  describe('loadAccount', () => {
    it('returns account from Horizon via circuit breaker', async () => {
      const mockAccount = { id: 'GABC', signers: [], thresholds: {}, sequence: '1', balances: [] };
      __mockServer.loadAccount.mockResolvedValue(mockAccount);

      const result = await loadAccount('GABC');

      expect(__mockServer.loadAccount).toHaveBeenCalledWith('GABC');
      expect(result).toEqual(mockAccount);
    });

    it('propagates Horizon errors when circuit is closed', async () => {
      const error = new Error('Not found');
      error.response = { status: 404 };
      __mockServer.loadAccount.mockRejectedValue(error);

      await expect(loadAccount('GABC')).rejects.toThrow('Not found');
    });

    it('throws CircuitBreakerOpenError when circuit is open', async () => {
      __mockServer.loadAccount.mockRejectedValue(new Error('ECONNREFUSED'));

      // Trip the breaker
      for (let i = 0; i < 6; i++) {
        try { await loadAccount('GABC'); } catch (_e) { /* trip breaker */ }
      }

      try {
        await loadAccount('GABC');
        throw new Error('Expected error to be thrown');
      } catch (err) {
        expect(err.code).toBe('EOPENBREAKER');
      }
    });
  });

  describe('fetchTransaction', () => {
    it('returns transaction via circuit breaker', async () => {
      const mockTx = { hash: 'abc123', created_at: '2024-01-01T00:00:00Z' };
      __mockTransactionCall.mockResolvedValue(mockTx);

      const result = await fetchTransaction('abc123');
      expect(result).toEqual(mockTx);
    });

    it('propagates Horizon errors when circuit is closed', async () => {
      __mockTransactionCall.mockRejectedValue(new Error('timeout'));

      await expect(fetchTransaction('abc123')).rejects.toThrow('timeout');
    });
  });

  describe('fetchPaymentsForTransaction', () => {
    it('returns payments via circuit breaker', async () => {
      const mockPayments = { records: [{ id: 1 }] };
      __mockCallFn.mockResolvedValue(mockPayments);

      const result = await fetchPaymentsForTransaction('abc123');
      expect(result).toEqual(mockPayments);
    });
  });

  describe('fetchPaymentsForAccount', () => {
    it('returns paginated payments via circuit breaker', async () => {
      const mockPage = { _embedded: { records: [] }, _links: {} };
      __mockCallFn.mockResolvedValue(mockPage);

      const result = await fetchPaymentsForAccount({
        address: 'GABC',
        limit: 10,
        cursor: 'now',
        order: 'desc',
      });

      expect(result).toEqual(mockPage);
    });
  });

  describe('fetchFirstPaymentsPage', () => {
    it('returns a page with circuit-breaker-protected next()', async () => {
      const mockNextFn = jest.fn().mockResolvedValue({ records: [] });
      const mockPage = { records: [{ id: 1 }], next: mockNextFn };
      __mockCallFn.mockResolvedValue(mockPage);

      const result = await fetchFirstPaymentsPage({
        address: 'GABC',
        order: 'desc',
        pageSize: 200,
      });

      expect(result.records).toEqual([{ id: 1 }]);
      expect(typeof result.next).toBe('function');

      const nextPage = await result.next();
      expect(nextPage).toEqual({ records: [] });
    });
  });

  describe('wrapPageWithBreaker', () => {
    it('wraps page.next() with circuit breaker', async () => {
      const mockNext = jest.fn().mockResolvedValue({ records: [2] });
      const page = { records: [1], next: mockNext };

      const wrapped = wrapPageWithBreaker(page);

      expect(wrapped.records).toEqual([1]);
      expect(typeof wrapped.next).toBe('function');

      const result = await wrapped.next();
      expect(result).toEqual({ records: [2] });
      expect(mockNext).toHaveBeenCalled();
    });

    it('returns page as-is if no next() function', () => {
      const page = { records: [1] };
      const wrapped = wrapPageWithBreaker(page);
      expect(wrapped).toBe(page);
    });

    it('returns falsy values as-is', () => {
      expect(wrapPageWithBreaker(null)).toBeNull();
      expect(wrapPageWithBreaker(undefined)).toBeUndefined();
    });

    it('fast-fails with CircuitBreakerOpenError when circuit is open', async () => {
      const mockNext = jest.fn().mockRejectedValue(new Error('timeout'));
      const page = { records: [1], next: mockNext };

      const wrapped = wrapPageWithBreaker(page);

      // Trip the breaker
      for (let i = 0; i < 6; i++) {
        try { await wrapped.next(); } catch (_e) { /* trip breaker */ }
      }

      try {
        await wrapped.next();
        throw new Error('Expected error to be thrown');
      } catch (err) {
        expect(err.code).toBe('EOPENBREAKER');
      }
    });
  });
});

describe('submitTransactionWithRetry', () => {
  const ok = { hash: 'abc' };
  const tx = { toXDR: () => 'xdr' };

  it('retries transient HTTP failures and succeeds', async () => {
    const submit = jest
      .fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce(ok);

    const result = await submitTransactionWithRetry(tx, {
      submit,
      sleep: jest.fn().mockResolvedValue(undefined),
      random: () => 0.5,
    });

    expect(result).toEqual(ok);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('retries tx_bad_seq', async () => {
    const submit = jest
      .fn()
      .mockRejectedValueOnce({ message: 'tx_bad_seq' })
      .mockResolvedValueOnce(ok);

    const result = await submitTransactionWithRetry(tx, {
      submit,
      sleep: jest.fn().mockResolvedValue(undefined),
    });

    expect(result).toEqual(ok);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent failures', async () => {
    const permanent = { message: 'op_underfunded', response: { status: 400 } };
    const submit = jest.fn().mockRejectedValue(permanent);

    await expect(
      submitTransactionWithRetry(tx, { submit, sleep: jest.fn() }),
    ).rejects.toBe(permanent);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after the maximum attempts', async () => {
    const last = { response: { status: 504 } };
    const submit = jest
      .fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ response: { status: 504 } })
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockRejectedValueOnce(last);

    await expect(
      submitTransactionWithRetry(tx, {
        submit,
        sleep: jest.fn().mockResolvedValue(undefined),
        random: () => 0,
      }),
    ).rejects.toBe(last);
    expect(submit).toHaveBeenCalledTimes(4);
  });

  it('detects retryable status codes and computed jitter bounds', () => {
    expect(isRetryableSubmissionError({ response: { status: 429 } })).toBe(true);
    expect(isRetryableSubmissionError({ response: { status: 503 } })).toBe(true);
    expect(isRetryableSubmissionError({ response: { status: 504 } })).toBe(true);
    expect(isRetryableSubmissionError({ message: 'tx_bad_seq' })).toBe(true);
    expect(isRetryableSubmissionError({ message: 'op_bad_auth' })).toBe(false);

    expect(computeBackoff(0, () => 0)).toBe(0);
    expect(computeBackoff(0, () => 0.999)).toBeLessThanOrEqual(200);
    expect(computeBackoff(3, () => 0.999)).toBeLessThanOrEqual(1600);
    expect(computeBackoff(10, () => 0.999)).toBeLessThanOrEqual(5000);
  });
});

'use strict';

/**
 * tests/exporter.test.js
 *
 * Unit tests for src/utils/exporter.js (issue #489) — the streaming CSV / NDJSON
 * export helpers used by the admin export route.
 */

const { EventEmitter } = require('events');

const exporter = require('../src/utils/exporter');

// ── helpers ──────────────────────────────────────────────────────────────────

const makeRecord = (i) => ({
  id: `txn-${i}`,
  createdAt: new Date('2026-01-15T12:00:00Z'),
  fromAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  toAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  amount: String(i * 100),
  assetCode: 'XLM',
  transactionHash: `hash-${i}`,
  status: 'completed',
});

/**
 * A minimal stand-in for an HTTP ServerResponse: records headers/status and,
 * when `backpressure` is set, applies write backpressure that resolves after a
 * drain event (so writeChunk's drain-waiting path can be exercised end to end).
 */
const makeRes = ({ backpressure = false } = {}) => {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.headers = {};
  res.statusCode = 200;
  res.write = jest.fn(() => {
    if (backpressure) {
      backpressure = false;
      setImmediate(() => res.emit('drain'));
      return false;
    }
    return true;
  });
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
  });
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.end = jest.fn(() => {
    res.writableEnded = true;
  });
  return res;
};

const makeLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const makePrisma = (findManyImpl) => ({
  payment: { findMany: jest.fn(findManyImpl) },
});

const writtenText = (res) =>
  res.write.mock.calls.map(([chunk]) => String(chunk)).join('');

// ── buildDateFilter ──────────────────────────────────────────────────────────

describe('buildDateFilter', () => {
  it('returns an empty clause when neither date is given', () => {
    expect(exporter.buildDateFilter()).toEqual({});
    expect(exporter.buildDateFilter(undefined, undefined)).toEqual({});
  });

  it('builds a gte filter when only startDate is given', () => {
    const result = exporter.buildDateFilter('2026-08-01');
    expect(result.createdAt.gte).toEqual(new Date('2026-08-01'));
    expect(result.createdAt.lte).toBeUndefined();
  });

  it('builds an end-of-day lte filter when only endDate is given', () => {
    const result = exporter.buildDateFilter(undefined, '2026-08-15');
    expect(result.createdAt.gte).toBeUndefined();
    expect(result.createdAt.lte.toISOString()).toBe('2026-08-15T23:59:59.999Z');
  });

  it('builds both bounds when startDate and endDate are given', () => {
    const result = exporter.buildDateFilter('2026-08-01', '2026-08-15');
    expect(result.createdAt.gte).toEqual(new Date('2026-08-01'));
    expect(result.createdAt.lte.toISOString()).toBe('2026-08-15T23:59:59.999Z');
  });
});

// ── streamAdminExport (CSV) ──────────────────────────────────────────────────

describe('streamAdminExport CSV', () => {
  it('writes a header row plus one row per record', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const page = [makeRecord(1), makeRecord(2)];
    const prisma = makePrisma(async () => page);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'corr-1',
    });

    expect(res.headers['Content-Type']).toMatch(/text\/csv/);
    expect(res.headers['Content-Disposition']).toMatch(/\.csv/);
    expect(res.end).toHaveBeenCalled();

    const text = writtenText(res);
    // Header row present — json2csv quotes field names by default.
    expect(text).toMatch(/"id"/);
    expect(text).toMatch(/txn-1/);
    expect(text).toMatch(/txn-2/);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('CSV export complete'));
  });

  it('returns an empty response when there are no records', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => []);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'corr-2',
    });

    expect(writtenText(res).trim()).toBe('');
    expect(res.end).toHaveBeenCalled();
  });

  it('passes date bounds through to the prisma query', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => []);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'csv',
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      logger,
      correlationId: 'corr-3',
    });

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it('handles socket backpressure by waiting for drain', async () => {
    const res = makeRes({ backpressure: true });
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeRecord(1), makeRecord(2)]);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'corr-4',
    });

    // Every record still made it to the response.
    expect(writtenText(res)).toMatch(/txn-2/);
    expect(res.end).toHaveBeenCalled();
  });

  it('logs a warning when the page cap truncates the export', async () => {
    process.env.EXPORT_MAX_PAGES = '2';
    try {
      const res = makeRes();
      const logger = makeLogger();
      const fullPage = Array.from({ length: exporter.PAGE_SIZE }, (_, i) => makeRecord(i));
      const prisma = makePrisma(async () => fullPage);

      await exporter.streamAdminExport({
        res,
        prisma,
        format: 'csv',
        logger,
        correlationId: 'corr-5',
      });

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('truncated'));
    } finally {
      delete process.env.EXPORT_MAX_PAGES;
    }
  });
});

// ── streamAdminExport (JSON) ─────────────────────────────────────────────────

describe('streamAdminExport JSON', () => {
  it('writes one NDJSON line per record with the right headers', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeRecord(1), makeRecord(2)]);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'json',
      logger,
      correlationId: 'corr-6',
    });

    expect(res.headers['Content-Type']).toMatch(/application\/x-ndjson/);
    expect(res.headers['Content-Disposition']).toMatch(/\.ndjson/);
    expect(res.end).toHaveBeenCalled();

    const lines = writtenText(res).trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).id).toBe('txn-1');
    expect(JSON.parse(lines[1]).id).toBe('txn-2');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('JSON export complete'));
  });

  it('returns an empty response when there are no records', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => []);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'json',
      logger,
      correlationId: 'corr-7',
    });

    expect(writtenText(res).trim()).toBe('');
    expect(res.end).toHaveBeenCalled();
  });
});

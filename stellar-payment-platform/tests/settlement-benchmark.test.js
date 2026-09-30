'use strict';

const { runSettlementBenchmark, percentile } = require('../src/settlement/benchmarkRunner');
const { main: runCliBenchmark } = require('../benchmarks/settlement-benchmark');

describe('Feature 27: Settlement Benchmark Suite', () => {
  test('percentile helper computes exact percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    const data = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(data, 50)).toBe(50);
    expect(percentile(data, 90)).toBe(90);
    expect(percentile(data, 99)).toBe(100);
  });

  test('runSettlementBenchmark runs and produces verified benchmark report', async () => {
    const report = await runSettlementBenchmark({ totalItems: 50, numShards: 4 });

    expect(report.testParameters.totalItems).toBe(50);
    expect(report.testParameters.numShards).toBe(4);
    expect(report.enqueueBenchmark.throughputTps).toBeGreaterThan(0);
    expect(report.settlementBenchmark.speedupFactor).toBeGreaterThan(0);
    expect(report.idempotencyConcurrencyTest.allCorrectlyReplayed).toBe(true);
    expect(report.cryptographicAuditBenchmark.proofValid).toBe(true);
  });

  test('CLI benchmark main function executes cleanly', async () => {
    process.env.BENCH_ITEMS = '20';
    process.env.BENCH_SHARDS = '2';

    const spyLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runCliBenchmark();
    spyLog.mockRestore();

    expect(result).toBeDefined();
    expect(result.testParameters.totalItems).toBe(20);
  });
});

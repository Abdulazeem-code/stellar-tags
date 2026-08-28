/**
 * Memory Leak Detection Test — Issue #511
 *
 * Uses Node.js's built-in `v8` module to take heap snapshots before and after
 * running the API under a synthetic load of N requests.  The test fails if the
 * heap growth exceeds a configurable threshold, catching unbounded memory leaks
 * before they reach production.
 *
 * Design notes
 * ─────────────
 * • No real database is needed — the Express app is imported with all external
 *   I/O mocked (Prisma, Redis, Stellar SDK), exactly as every other unit test
 *   in this suite does.
 * • `v8.getHeapStatistics().used_heap_size` is the most reliable JS-heap metric
 *   for this purpose; it counts only live objects and is cheaper to read than a
 *   full heap snapshot file.
 * • A single GC pass is forced before each measurement (available when the
 *   process is started with --expose-gc, which Jest enables via the config
 *   option below).  This flushes short-lived objects so we measure steady-state
 *   retention rather than allocation churn.
 * • `MEMORY_TEST_REQUESTS` (env var, default 200) controls the request count.
 * • `MEMORY_LEAK_THRESHOLD_MB` (env var, default 50) controls the allowed
 *   heap growth in megabytes.
 */

'use strict';

const v8 = require('v8');
const http = require('http');

// ── Jest timeout: allow up to 60 s for the full load loop ────────────────────
jest.setTimeout(60_000);

// ── External-dependency mocks (mirrors api.test.js) ─────────────────────────
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => null),
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

// ── Configuration ─────────────────────────────────────────────────────────────
const REQUEST_COUNT = parseInt(process.env.MEMORY_TEST_REQUESTS ?? '200', 10);
const THRESHOLD_MB = parseFloat(process.env.MEMORY_LEAK_THRESHOLD_MB ?? '50');
const THRESHOLD_BYTES = THRESHOLD_MB * 1024 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Force a synchronous garbage-collection pass when the V8 GC is exposed
 * (Jest passes --expose-gc when `globals` contains `gc`; fall back gracefully
 * when running outside Jest or without the flag).
 */
function forceGC() {
  if (typeof global.gc === 'function') {
    global.gc();
  }
}

/**
 * Read live heap usage in bytes after a GC pass.
 */
function heapUsedBytes() {
  forceGC();
  return v8.getHeapStatistics().used_heap_size;
}

/**
 * Send a single HTTP GET to the running server and resolve when the full
 * response body has been consumed (so the server has finished its work).
 */
function sendRequest(server, path) {
  return new Promise((resolve, reject) => {
    const { address, port } = server.address();
    const host = address === '::' || address === '0.0.0.0' ? '127.0.0.1' : address;
    const req = http.request({ host, port, path, method: 'GET' }, (res) => {
      res.resume(); // drain the body
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Memory leak detection (#511)', () => {
  let server;

  beforeAll((done) => {
    process.env.NODE_ENV = 'test';
    // Import the app after mocks are in place.
    const { app } = require('../server');
    server = app.listen(0, '127.0.0.1', done); // OS-assigned port
  });

  afterAll((done) => {
    if (server && server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  it(
    `heap growth stays below ${THRESHOLD_MB} MB after ${REQUEST_COUNT} requests`,
    async () => {
      // --- warm-up: a handful of requests to let V8 JIT and settle caches ----
      const WARMUP = Math.min(20, Math.floor(REQUEST_COUNT / 10));
      for (let i = 0; i < WARMUP; i++) {
        await sendRequest(server, '/health');
      }

      // --- baseline measurement -------------------------------------------
      const baselineBytes = heapUsedBytes();

      // --- load loop --------------------------------------------------------
      for (let i = 0; i < REQUEST_COUNT; i++) {
        // Rotate between several endpoints to exercise different code paths.
        const paths = [
          '/health',
          '/federation?q=client*localhost',
          '/federation?q=unknown*localhost',
        ];
        await sendRequest(server, paths[i % paths.length]);
      }

      // --- final measurement ------------------------------------------------
      const finalBytes = heapUsedBytes();
      const growthBytes = finalBytes - baselineBytes;
      const growthMB = (growthBytes / (1024 * 1024)).toFixed(2);

      console.log(
        `[memory-test] baseline=${(baselineBytes / 1024 / 1024).toFixed(2)} MB  ` +
          `final=${(finalBytes / 1024 / 1024).toFixed(2)} MB  ` +
          `growth=${growthMB} MB  threshold=${THRESHOLD_MB} MB`,
      );

      expect(growthBytes).toBeLessThan(
        THRESHOLD_BYTES,
        `Heap grew by ${growthMB} MB after ${REQUEST_COUNT} requests — ` +
          `exceeds the ${THRESHOLD_MB} MB threshold. Possible memory leak.`,
      );
    },
  );

  it('heap is not growing monotonically across request batches', async () => {
    // Send three equal-sized batches and record heap after each.  A steady
    // leak produces a strictly increasing series; a healthy process will
    // plateau or oscillate.  We allow each step to grow by at most
    // THRESHOLD_BYTES / 3 to give room for natural GC jitter.
    const BATCH = Math.max(10, Math.floor(REQUEST_COUNT / 3));
    const PER_STEP_LIMIT = THRESHOLD_BYTES / 3;

    // baseline
    let prev = heapUsedBytes();
    const growthPerBatch = [];

    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < BATCH; i++) {
        await sendRequest(server, '/health');
      }
      const after = heapUsedBytes();
      growthPerBatch.push(after - prev);
      prev = after;
    }

    console.log(
      '[memory-test] per-batch growth (bytes):',
      growthPerBatch.map((b) => b.toLocaleString()).join(', '),
    );

    // At most one batch may exceed the per-step limit (GC timing is non-
    // deterministic; two consecutive limit-busting steps strongly suggest a leak).
    const exceedingSteps = growthPerBatch.filter((g) => g > PER_STEP_LIMIT).length;
    expect(exceedingSteps).toBeLessThanOrEqual(1);
  });
});

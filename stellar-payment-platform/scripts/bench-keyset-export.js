'use strict';

/**
 * scripts/bench-keyset-export.js
 *
 * Benchmark for issue #677: compares the OLD offset walk (skip: page * n)
 * against the NEW keyset seek (orderBy (created_at, id) + cursor predicate)
 * used by the admin payment-history export.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/bench-keyset-export.js [rows]
 *
 * Requires the `payments` table (prisma migrate deploy) and PostgreSQL.
 */

const { PrismaClient } = require('@prisma/client');
const { keysetWhereDescById } = require('../src/pagination');

const prisma = new PrismaClient();
const PAGE_SIZE = 500; // matches exporter.PAGE_SIZE

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);

async function seed(total) {
  const agg = await prisma.payment.aggregate({ _count: { _all: true } });
  const count = agg._count._all;
  if (count >= total) {
    console.log(`seed: ${count} rows already present, skipping`);
    return;
  }
  console.log(`seed: inserting ${total} rows (many rows share timestamps)...`);
  const t0 = Date.now();
  // Timestamps bucketed per minute → ~4 rows per bucket at 200k/50k buckets,
  // which exercises the (createdAt, id) tie-breaker path of the keyset walk.
  await prisma.$executeRawUnsafe(`
    INSERT INTO payments (id, created_at, from_address, to_address, amount, fee, asset_code, status)
    SELECT gen_random_uuid()::text,
           now() - ((i % 50000) || ' minutes')::interval,
           'G' || lpad((i % 100)::text, 55, '0'),
           'G' || lpad(((i * 7) % 100)::text, 55, '0'),
           (i % 1000)::float,
           0.01,
           'XLM',
           'completed'
    FROM generate_series(${count}, ${total - 1}) AS s(i)
  `);
  await prisma.$queryRawUnsafe(`ANALYZE payments`);
  console.log(`seed: done in ${fmtMs(Date.now() - t0)}`);
}

/** OLD approach — identical shape to the pre-change exporter queries. */
async function benchOffset(pages) {
  const perPage = [];
  const t0 = Date.now();
  for (let page = 0; page < pages; page++) {
    const tPage = Date.now();
    const rows = await prisma.payment.findMany({
      where: {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, createdAt: true },
    });
    perPage.push({ page, ms: Date.now() - tPage, rows: rows.length });
    if (rows.length < PAGE_SIZE) break;
  }
  return { total: Date.now() - t0, perPage };
}

/** NEW approach — identical shape to the post-change exporter queries. */
async function benchKeyset(pages) {
  const perPage = [];
  let cursor = null;
  const t0 = Date.now();
  for (let page = 0; page < pages; page++) {
    const tPage = Date.now();
    const where = cursor ? { AND: [{}, keysetWhereDescById(cursor)] } : {};
    const rows = await prisma.payment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE,
      select: { id: true, createdAt: true },
    });
    perPage.push({ page, ms: Date.now() - tPage, rows: rows.length });
    if (rows.length < PAGE_SIZE) break;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }
  return { total: Date.now() - t0, perPage };
}

const summarize = (name, { total, perPage }) => {
  const first = perPage[0];
  const mid = perPage[Math.floor(perPage.length / 2)];
  const last = perPage[perPage.length - 1];
  const n = perPage.length;
  const rows = perPage.reduce((acc, p) => acc + p.rows, 0);
  console.log(`\n${name}:`);
  console.log(`  pages fetched:   ${n} (${rows} rows)`);
  console.log(`  total time:      ${fmtMs(total)}`);
  console.log(`  page 1 latency:  ${fmtMs(first.ms)}`);
  console.log(`  page ${mid.page + 1} latency:  ${fmtMs(mid.ms)}`);
  console.log(`  page ${last.page + 1} latency:  ${fmtMs(last.ms)}`);
  console.log(`  growth p1→pN:    ${(last.ms / Math.max(first.ms, 0.01)).toFixed(1)}x`);
};

(async () => {
  const total = Number(process.argv[2]) || 200000;
  try {
    await seed(total);

    const rows = await prisma.payment.aggregate({ _count: { _all: true } });
    const pages = Math.ceil(rows._count._all / PAGE_SIZE);

    console.log(`\nbenchmark: ${rows._count._all} rows, ${PAGE_SIZE}/page → ${pages} pages`);

    const offset = await benchOffset(pages);
    summarize('OLD — OFFSET walk (skip: page * 500)', offset);

    const keyset = await benchKeyset(pages);
    summarize('NEW — keyset seek ((created_at, id) tuple)', keyset);

    console.log(`\nresult: keyset total is ${(offset.total / keyset.total).toFixed(2)}x faster over a full export`);
  } finally {
    await prisma.$disconnect();
  }
})();

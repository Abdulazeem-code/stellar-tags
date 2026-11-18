import {
  ANALYTICS_MAX_PAGES,
  ANALYTICS_PAGE_LIMIT,
  ANALYTICS_WINDOW_MS,
  HORIZON_BASE,
} from '../views/shared';

const BUCKET_MS = 5 * 60 * 1000;
const BUCKETS = ANALYTICS_WINDOW_MS / BUCKET_MS;

const fetchHorizon = async (url, signal) => {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Horizon error (${response.status}).`);
  return response.json();
};

// Walks a Horizon collection newest first and hands each record inside the
// window to `visit`, stopping at the window edge or after the page cap.
const walkWindow = async (path, timeKey, sinceMs, signal, visit) => {
  let url = `${HORIZON_BASE}/${path}?order=desc&limit=${ANALYTICS_PAGE_LIMIT}`;
  for (let page = 0; url && page < ANALYTICS_MAX_PAGES; page += 1) {
    const data = await fetchHorizon(url, signal);
    const records = data?._embedded?.records ?? [];
    if (!records.length) return;
    for (const record of records) {
      const at = Date.parse(record[timeKey]);
      if (!Number.isFinite(at) || at < sinceMs) return;
      visit(record, at);
    }
    url = data?._links?.next?.href;
  }
};

/**
 * Network-wide testnet metrics for the last hour, read from Horizon: native
 * payment volume (total and per 5 minutes), ledger close times and the
 * transaction success rate.
 */
export async function loadNetworkMetrics(signal) {
  const now = Date.now();
  const sinceMs = now - ANALYTICS_WINDOW_MS;
  const bucketOf = (at) => Math.min(BUCKETS - 1, Math.max(0, BUCKETS - 1 - Math.floor((now - at) / BUCKET_MS)));

  const volumeBuckets = new Array(BUCKETS).fill(0);
  let volume = 0;
  let payments = 0;
  const volumeTask = walkWindow('payments', 'created_at', sinceMs, signal, (record, at) => {
    payments += 1;
    if (record.asset_type === 'native' && record.amount) {
      const amount = Number(record.amount) || 0;
      volume += amount;
      volumeBuckets[bucketOf(at)] += amount;
    }
  });

  const ledgerDeltas = [];
  let previous = null;
  let latestLedger = null;
  const ledgerTask = walkWindow('ledgers', 'closed_at', sinceMs, signal, (record, at) => {
    if (latestLedger === null) latestLedger = record.sequence;
    if (previous !== null && previous > at) ledgerDeltas.push((previous - at) / 1000);
    previous = at;
  });

  let txCount = 0;
  let txSuccess = 0;
  const txTask = walkWindow('transactions', 'created_at', sinceMs, signal, (record) => {
    txCount += 1;
    if (record.successful) txSuccess += 1;
  });

  await Promise.all([volumeTask, ledgerTask, txTask]);

  return {
    volume,
    volumeBuckets,
    payments,
    ledgerDeltas: ledgerDeltas.reverse(),
    avgConfirmation: ledgerDeltas.length
      ? ledgerDeltas.reduce((sum, value) => sum + value, 0) / ledgerDeltas.length
      : null,
    latestLedger,
    txCount,
    successRate: txCount ? (txSuccess / txCount) * 100 : null,
    updatedAt: now,
  };
}

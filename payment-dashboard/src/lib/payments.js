import { HORIZON_BASE } from '../views/shared';

const PAYMENT_TYPES = [
  'payment',
  'path_payment_strict_receive',
  'path_payment_strict_send',
  'create_account',
  'account_merge',
  'invoke_host_function',
];

const explorerTx = (hash) =>
  hash ? `https://stellar.expert/explorer/testnet/tx/${hash}` : '';

/**
 * Loads an account's recent payments from Horizon and flattens them into rows:
 * { id, counterparty, direction: 'Sent'|'Received', amount, amountValue,
 *   asset, status, type, createdAt, transactionHash, explorerLink }.
 * Soroban contract calls are expanded into one row per native balance change
 * that touches the account.
 */
export async function fetchAccountPayments(publicKey, { limit = 25, signal } = {}) {
  const response = await fetch(
    `${HORIZON_BASE}/accounts/${publicKey}/payments?order=desc&limit=${limit}`,
    { signal, cache: 'no-store' },
  );
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`Horizon error (${response.status}).`);
  }

  const data = await response.json();
  const records = (data?._embedded?.records ?? []).filter((record) =>
    PAYMENT_TYPES.includes(record.type),
  );

  return records
    .flatMap((record) => {
      const status = record.transaction_successful === false ? 'Failed' : 'Success';

      if (record.type === 'invoke_host_function' && record.asset_balance_changes?.length) {
        return record.asset_balance_changes
          .filter((change) => change.asset_type === 'native')
          .filter((change) => change.from === publicKey || change.to === publicKey)
          .map((change, index) => {
            const sent = change.from === publicKey;
            return {
              id: `${record.id}-${index}`,
              counterparty: (sent ? change.to : change.from) || 'Unknown',
              direction: sent ? 'Sent' : 'Received',
              amount: `${change.amount} XLM`,
              amountValue: Number(change.amount) || 0,
              asset: 'XLM',
              status,
              type: record.type,
              createdAt: record.created_at,
              transactionHash: record.transaction_hash,
              explorerLink: explorerTx(record.transaction_hash),
            };
          });
      }

      const isSender = record.from === publicKey || record.account === publicKey;
      const isReceiver = record.to === publicKey || record.into === publicKey;
      const direction = isSender && !isReceiver ? 'Sent' : isReceiver ? 'Received' : 'Sent';
      const counterparty =
        direction === 'Sent'
          ? record.to || record.into || record.account || 'Unknown'
          : record.from || record.funder || record.account || 'Unknown';
      const asset = record.asset_type === 'native' ? 'XLM' : record.asset_code || 'Asset';
      const rawAmount = record.amount || record.starting_balance || '';

      return [
        {
          id: String(record.id),
          counterparty,
          direction,
          amount: rawAmount ? `${rawAmount} ${asset}` : '-',
          amountValue: Number(rawAmount) || 0,
          asset,
          status,
          type: record.type,
          createdAt: record.created_at,
          transactionHash: record.transaction_hash,
          explorerLink: explorerTx(record.transaction_hash),
        },
      ];
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Short relative time, e.g. "2 min ago", "yesterday", "Oct 18". */
export function relativeTime(iso) {
  const then = new Date(iso);
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 172800) return 'yesterday';
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Sums XLM moved per day over the last `days` days, oldest first. */
export function dailyVolume(rows, days = 14) {
  const buckets = new Array(days).fill(0);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  for (const row of rows) {
    if (row.asset !== 'XLM' || row.status !== 'Success') continue;
    const day = new Date(row.createdAt);
    day.setHours(0, 0, 0, 0);
    const age = Math.round((startOfToday - day) / 86400000);
    if (age >= 0 && age < days) {
      buckets[days - 1 - age] += row.amountValue;
    }
  }
  return buckets;
}

export function toCsv(rows) {
  const header = ['time', 'direction', 'counterparty', 'amount', 'asset', 'status', 'type', 'hash'];
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((row) =>
    [
      row.createdAt,
      row.direction,
      row.counterparty,
      row.amountValue,
      row.asset,
      row.status,
      row.type,
      row.transactionHash,
    ]
      .map(escape)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

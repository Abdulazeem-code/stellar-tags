import { Fragment, useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon';
import ConnectPrompt from '../components/ConnectPrompt';
import { fetchAccountPayments, relativeTime, toCsv } from '../lib/payments';
import { errorMessage, formatShortAddress } from './shared';

const FILTERS = ['All', 'Sent', 'Received', 'Failed'];

const TYPE_LABEL = {
  payment: 'Payment',
  path_payment_strict_receive: 'Path payment',
  path_payment_strict_send: 'Path payment',
  create_account: 'Account created',
  account_merge: 'Account merge',
  invoke_host_function: 'Contract call',
};

function downloadCsv(rows) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `stellar-tags-history-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function HistoryPage({ userPublicKey, onConnectWallet, onRefreshBalance }) {
  const [result, setResult] = useState({ key: '', rows: [], error: '' });
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [filter, setFilter] = useState('All');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const requestKey = `${userPublicKey}:${refreshIndex}`;

  useEffect(() => {
    if (!userPublicKey) return undefined;
    const controller = new AbortController();
    fetchAccountPayments(userPublicKey, { limit: 100, signal: controller.signal })
      .then((rows) => {
        // Refresh the balance once when a new successful payment shows up.
        const latest = rows[0];
        if (latest?.status === 'Success') {
          const latestKey = `${latest.transactionHash || latest.id}-${latest.amount}`;
          if (latestKey !== sessionStorage.getItem('stellar-last-tx')) {
            sessionStorage.setItem('stellar-last-tx', latestKey);
            onRefreshBalance();
          }
        }
        setResult({ key: `${userPublicKey}:${refreshIndex}`, rows, error: '' });
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setResult({
          key: `${userPublicKey}:${refreshIndex}`,
          rows: [],
          error: errorMessage(error, 'Unable to load transaction history.'),
        });
      });
    return () => controller.abort();
  }, [userPublicKey, refreshIndex, onRefreshBalance]);

  useEffect(() => {
    const handleUpdate = () => setRefreshIndex((value) => value + 1);
    window.addEventListener('stellar:tx-update', handleUpdate);
    return () => window.removeEventListener('stellar:tx-update', handleUpdate);
  }, []);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return result.rows.filter((row) => {
      if (filter === 'Failed' && row.status !== 'Failed') return false;
      if ((filter === 'Sent' || filter === 'Received') && row.direction !== filter) return false;
      if (!needle) return true;
      return [row.counterparty, row.transactionHash, row.amount, row.type]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [result.rows, filter, query]);

  if (!userPublicKey) {
    return (
      <ConnectPrompt
        onConnectWallet={onConnectWallet}
        title="Connect a wallet to read its ledger."
        body="History comes straight from Horizon, so it covers payments made from any app, not only this one."
      />
    );
  }

  const isLoading = result.key !== requestKey;
  const totals = result.rows.reduce(
    (acc, row) => {
      if (row.asset !== 'XLM' || row.status !== 'Success') return acc;
      if (row.direction === 'Sent') acc.out += row.amountValue;
      else acc.in += row.amountValue;
      return acc;
    },
    { in: 0, out: 0 },
  );

  return (
    <div className="stack">
      <section className="stat-row">
        <div className="stat">
          <span className="eyebrow">Received</span>
          <strong className="mono text-blue">+{totals.in.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
          <span className="muted small">XLM, last 100 operations</span>
        </div>
        <div className="stat">
          <span className="eyebrow">Sent</span>
          <strong className="mono">-{totals.out.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
          <span className="muted small">XLM, last 100 operations</span>
        </div>
        <div className="stat">
          <span className="eyebrow">Operations</span>
          <strong className="mono">{result.rows.length}</strong>
          <span className="muted small">{result.rows.filter((row) => row.status === 'Failed').length} failed</span>
        </div>
      </section>

      <section className="card">
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Filter">
            {FILTERS.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={filter === name}
                onClick={() => setFilter(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="field field--search">
            <Icon name="search" size={16} className="field__icon" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search address, hash, amount"
              aria-label="Search history"
            />
          </div>
          <div className="row-gap">
            <button
              type="button"
              className="icon-button"
              onClick={() => setRefreshIndex((value) => value + 1)}
              disabled={isLoading}
            >
              <Icon name="refresh" size={16} label="Refresh" className={isLoading ? 'spin' : ''} />
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => downloadCsv(rows)}
              disabled={!rows.length}
            >
              <Icon name="download" size={14} /> CSV
            </button>
          </div>
        </div>

        {result.error && <p className="notice notice--error">{result.error}</p>}

        {isLoading && !result.rows.length ? (
          <div className="skeleton-list" aria-busy="true">
            {[0, 1, 2, 3, 4].map((index) => (
              <span key={index} className="skeleton dither-12" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-inline">
            <span className="empty-inline__art dither-12" aria-hidden="true" />
            <p className="muted">
              {result.rows.length ? 'Nothing matches that filter.' : 'No payments on this account yet.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Direction</th>
                  <th scope="col">Counterparty</th>
                  <th scope="col" className="hide-sm">Type</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col" className="hide-sm">Status</th>
                  <th scope="col" className="hide-sm">When</th>
                  <th scope="col"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const open = expandedId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr className={open ? 'is-open' : ''}>
                        <td>
                          <span className={`dir ${row.direction === 'Sent' ? '' : 'dir--in'}`}>
                            <Icon name={row.direction === 'Sent' ? 'send' : 'receive'} size={14} />
                            {row.direction}
                          </span>
                        </td>
                        <td className="mono">{formatShortAddress(row.counterparty)}</td>
                        <td className="hide-sm muted">{TYPE_LABEL[row.type] || row.type}</td>
                        <td className={`num mono ${row.direction === 'Sent' ? '' : 'text-blue'}`}>
                          {row.direction === 'Sent' ? '-' : '+'}
                          {row.amount}
                        </td>
                        <td className="hide-sm">
                          <span className={`status status--${row.status.toLowerCase()}`}>{row.status}</span>
                        </td>
                        <td className="hide-sm muted">{relativeTime(row.createdAt)}</td>
                        <td className="num">
                          <button
                            type="button"
                            className="icon-button icon-button--sm"
                            aria-expanded={open}
                            onClick={() => setExpandedId(open ? null : row.id)}
                          >
                            <Icon name={open ? 'minus' : 'plus'} size={14} label={open ? 'Hide details' : 'Show details'} />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="ledger__detail">
                          <td colSpan={7}>
                            <dl className="detail-grid">
                              <div>
                                <dt>Counterparty</dt>
                                <dd className="mono break">{row.counterparty}</dd>
                              </div>
                              <div>
                                <dt>Transaction</dt>
                                <dd className="mono break">{row.transactionHash || '-'}</dd>
                              </div>
                              <div>
                                <dt>Time</dt>
                                <dd>{new Date(row.createdAt).toLocaleString()}</dd>
                              </div>
                              <div>
                                <dt>Status</dt>
                                <dd>
                                  <span className={`status status--${row.status.toLowerCase()}`}>{row.status}</span>
                                </dd>
                              </div>
                            </dl>
                            {row.explorerLink && (
                              <a className="btn btn--ghost btn--sm" href={row.explorerLink} target="_blank" rel="noopener noreferrer">
                                View on Stellar Expert <Icon name="external" size={14} />
                              </a>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default HistoryPage;

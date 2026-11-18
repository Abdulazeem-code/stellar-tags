import { useEffect, useState } from 'react';
import Icon from '../components/Icon';
import LatencyGauge from '../LatencyGauge';
import { useLatencyTracker } from '../useLatencyTracker';
import { loadNetworkMetrics } from '../lib/network';
import { API_BASE, ANALYTICS_REFRESH_MS } from './shared';

const fmt = (value, options) =>
  value === null || value === undefined ? '--' : new Intl.NumberFormat('en-US', options).format(value);

function Kpi({ label, value, unit, note, accent }) {
  return (
    <div className={`kpi ${accent ? 'kpi--accent' : ''}`}>
      <span className="eyebrow">{label}</span>
      <strong className="kpi__value mono">
        {value}
        {unit && <span className="kpi__unit">{unit}</span>}
      </strong>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

function Bars({ values, label, format, highlightLast = true }) {
  const max = Math.max(...values, 1);
  return (
    <div className="bars" role="img" aria-label={label}>
      {values.map((value, index) => (
        <span
          key={index}
          className={`bars__bar ${highlightLast && index === values.length - 1 ? 'blue-fill' : 'dither-blue-50'}`}
          style={{ height: `${Math.max(3, (value / max) * 100)}%` }}
          title={format(value)}
        />
      ))}
    </div>
  );
}

function AnalyticsPage() {
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState('');
  const latency = useLatencyTracker(API_BASE);

  useEffect(() => {
    let controller = null;
    const load = async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const next = await loadNetworkMetrics(current.signal);
        setMetrics(next);
        setError('');
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message || 'Horizon did not answer.');
      }
    };
    load();
    const id = setInterval(load, ANALYTICS_REFRESH_MS);
    return () => {
      clearInterval(id);
      controller?.abort();
    };
  }, []);

  const loading = !metrics && !error;
  const pending = error ? 'Unavailable' : 'Loading';
  const deltas = metrics?.ledgerDeltas.slice(-60) ?? [];

  return (
    <div className="stack">
      {error && (
        <p className="notice notice--error">
          Could not reach Horizon ({error}). {metrics ? 'Showing the last values we had.' : 'Retrying every minute.'}
        </p>
      )}

      <section className="kpi-grid" aria-busy={loading}>
        <Kpi
          label="Routing volume"
          value={fmt(metrics?.volume, { maximumFractionDigits: 0 })}
          unit=" XLM"
          note={metrics ? `${fmt(metrics.payments)} payments` : pending}
          accent
        />
        <Kpi
          label="Avg ledger close"
          value={fmt(metrics?.avgConfirmation, { maximumFractionDigits: 2 })}
          unit="s"
          note={metrics?.latestLedger ? `Ledger ${fmt(metrics.latestLedger)}` : pending}
        />
        <Kpi
          label="Success rate"
          value={fmt(metrics?.successRate, { maximumFractionDigits: 1 })}
          unit="%"
          note={metrics ? `${fmt(metrics.txCount)} transactions` : pending}
        />
        <div className="kpi">
          <span className="eyebrow">API latency</span>
          <LatencyGauge latency={latency.latency} status={latency.status} />
          <span className="muted small">Pinged every 30s</span>
        </div>
      </section>

      <section className="card">
        <div className="card__head">
          <h2 className="h4">Native XLM volume, 5-minute buckets</h2>
          <span className="mono muted small">last 60 min</span>
        </div>
        {metrics ? (
          <Bars
            values={metrics.volumeBuckets}
            label="Native XLM volume per five minutes over the last hour"
            format={(value) => `${fmt(value, { maximumFractionDigits: 0 })} XLM`}
          />
        ) : (
          <span className="skeleton skeleton--chart dither-12" />
        )}
        <div className="volume__axis mono">
          <span>-60m</span>
          <span>-30m</span>
          <span>now</span>
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <div className="card__head">
            <h2 className="h4">Ledger close time</h2>
            <span className="mono muted small">last {deltas.length} ledgers</span>
          </div>
          {metrics ? (
            <Bars
              values={deltas}
              label="Seconds between recent ledger closes"
              format={(value) => `${value.toFixed(1)}s`}
            />
          ) : (
            <span className="skeleton skeleton--chart dither-12" />
          )}
        </section>
        <section className="card integrity">
          <div className="card__head">
            <h2 className="h4">Integrity</h2>
            <Icon name="check" size={16} className="text-blue" />
          </div>
          <ul className="checks">
            <li>
              <span className="dot dot--blue" aria-hidden="true" /> Payments route through the audited
              payment_router contract.
            </li>
            <li>
              <span className="dot dot--blue" aria-hidden="true" /> Every number here is read from public
              Horizon, not our API.
            </li>
            <li>
              <span className="dot dot--blue" aria-hidden="true" /> Metrics refresh every{' '}
              {ANALYTICS_REFRESH_MS / 1000}s.
            </li>
          </ul>
          {metrics && (
            <p className="mono muted small">Updated {new Date(metrics.updatedAt).toLocaleTimeString()}</p>
          )}
        </section>
      </div>
    </div>
  );
}

export default AnalyticsPage;

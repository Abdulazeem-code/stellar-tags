import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Client as PaymentRouterClient, networks } from '@stellar-tags/payment-router';
import Icon from '../components/Icon';
import ConnectPrompt from '../components/ConnectPrompt';
import RecentAddresses from '../components/RecentAddresses';
import { useRecentAddresses } from '../useRecentAddresses';
import { signTransaction } from '../lib/wallets';
import { SOROBAN_RPC, submitAndWait } from '../lib/soroban';
import { dailyVolume, fetchAccountPayments, relativeTime } from '../lib/payments';
import {
  API_BASE,
  DEFAULT_FEDERATION_DOMAIN,
  TOKEN_ADDRESS,
  apiErrorMessage,
  errorMessage,
  formatShortAddress,
  fullTag,
  resolveRecipient,
} from './shared';

const QUICK_AMOUNTS = [10, 50, 100, 250];

function splitBalance(value) {
  const [whole, fraction = ''] = value.toFixed(7).split('.');
  return {
    whole: Number(whole).toLocaleString(),
    head: fraction.slice(0, 2),
    tail: fraction.slice(2),
  };
}

function VolumeBars({ rows }) {
  const buckets = useMemo(() => dailyVolume(rows, 14), [rows]);
  const max = Math.max(...buckets, 1);
  const total = buckets.reduce((sum, value) => sum + value, 0);
  return (
    <div className="volume">
      <div className="volume__head">
        <span className="eyebrow">14-day volume</span>
        <span className="mono">{total.toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM</span>
      </div>
      <div className="volume__bars" role="img" aria-label={`XLM moved per day over 14 days, ${total.toFixed(2)} in total`}>
        {buckets.map((value, index) => (
          <span
            key={index}
            className={`volume__bar ${index === buckets.length - 1 ? 'blue-fill' : 'dither-blue-50'}`}
            style={{ height: `${Math.max(4, (value / max) * 100)}%` }}
            title={`${value.toFixed(2)} XLM`}
          />
        ))}
      </div>
      <div className="volume__axis mono">
        <span>-14d</span>
        <span>today</span>
      </div>
    </div>
  );
}

function ActivityList({ state, onNavigate }) {
  if (state.loading) {
    return (
      <div className="skeleton-list" aria-busy="true">
        {[0, 1, 2].map((index) => (
          <span key={index} className="skeleton dither-12" />
        ))}
      </div>
    );
  }
  if (state.error) return <p className="muted">{state.error}</p>;
  if (!state.rows.length) {
    return <p className="muted">No payments yet. Send one, or share your tag to receive.</p>;
  }
  return (
    <>
      <ul className="activity">
        {state.rows.slice(0, 6).map((row) => (
          <li key={row.id} className="activity__row">
            <span className={`activity__icon ${row.direction === 'Sent' ? '' : 'is-in'}`} aria-hidden="true">
              <Icon name={row.direction === 'Sent' ? 'send' : 'receive'} size={14} />
            </span>
            <span className="activity__who">
              <span className="mono">{formatShortAddress(row.counterparty)}</span>
              <span className="muted small">{relativeTime(row.createdAt)}</span>
            </span>
            <span className={`mono activity__amt ${row.direction === 'Sent' ? '' : 'text-blue'}`}>
              {row.direction === 'Sent' ? '-' : '+'}
              {row.amount}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn--ghost btn--block" onClick={() => onNavigate('history')}>
        Full history <Icon name="arrow" size={14} />
      </button>
    </>
  );
}

function SendPanel({ userPublicKey, onRefreshBalance }) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [showRecent, setShowRecent] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState({ tone: '', text: '' });
  const { recentAddresses, saveAddress, clearAddresses } = useRecentAddresses();
  const recipientRef = useRef(null);
  const closeRecent = useCallback(() => setShowRecent(false), []);

  const handleSend = async (event) => {
    event.preventDefault();
    if (isProcessing) return;

    const recipientInput = recipient.trim();
    const amountValue = parseFloat(amount);
    if (!amountValue || Number.isNaN(amountValue) || amountValue <= 0) {
      toast.error('Enter an amount greater than zero.');
      return;
    }

    setIsProcessing(true);
    setMessage({ tone: '', text: '' });
    const toastId = toast.loading('Resolving recipient...');

    try {
      const resolved = await resolveRecipient(recipientInput);
      if (resolved.error) throw new Error(resolved.error);

      let recipientAddress = resolved.address;
      if (!recipientAddress && resolved.tag) {
        const response = await fetch(
          `${API_BASE}/federation?q=${encodeURIComponent(resolved.tag)}&type=name`,
        );
        const data = response.ok ? await response.json() : null;
        if (!data?.account_id) throw new Error(`No wallet is registered for ${resolved.tag}.`);
        recipientAddress = data.account_id;
      }

      toast.loading('Simulating the payment_router call...', { id: toastId });
      const amountStroops = BigInt(Math.floor(amountValue * 10000000));

      // Build and simulate the payment through the type-safe client generated
      // from the contract ABI (packages/types). The sender has to be the
      // transaction source: without publicKey the SDK builds the transaction
      // from a placeholder account and the network rejects it.
      const client = new PaymentRouterClient({
        ...networks.testnet,
        rpcUrl: SOROBAN_RPC,
        publicKey: userPublicKey,
      });

      let assembledTransaction;
      try {
        assembledTransaction = await client.route_payment({
          sender: userPublicKey,
          recipient: recipientAddress,
          token_address: TOKEN_ADDRESS,
          amount: amountStroops,
        });
      } catch (err) {
        if (/account not found/i.test(err?.message || '')) {
          throw new Error('Your account does not exist on testnet yet. Fund it with Friendbot first.', { cause: err });
        }
        throw new Error(`Simulation failed: ${err.message}`, { cause: err });
      }
      if (assembledTransaction.result?.isErr?.()) {
        const reason = assembledTransaction.result.unwrapErr()?.message;
        throw new Error(`The payment_router contract refused this payment${reason ? `: ${reason}` : '.'}`);
      }

      toast.loading('Approve the transaction in your wallet...', { id: toastId });
      let signedXdr;
      try {
        signedXdr = await signTransaction(assembledTransaction.toXDR(), userPublicKey);
      } catch (err) {
        throw new Error(`Wallet signature failed: ${err?.message || 'rejected'}`, { cause: err });
      }

      toast.loading('Waiting for the ledger to confirm...', { id: toastId });
      const txHash = await submitAndWait(signedXdr, networks.testnet.networkPassphrase);

      const explorerUrl = txHash ? `https://stellar.expert/explorer/testnet/tx/${txHash}` : null;
      toast.success(
        (t) => (
          <span>
            Sent {amountValue} XLM.
            {explorerUrl && (
              <>
                {' '}
                <a href={explorerUrl} target="_blank" rel="noopener noreferrer" onClick={() => toast.dismiss(t.id)}>
                  View on Stellar Expert
                </a>
              </>
            )}
          </span>
        ),
        { id: toastId, duration: 8000 },
      );
      setMessage({ tone: 'ok', text: `Sent ${amountValue} XLM to ${recipientInput}.` });
      saveAddress(recipientInput);
      setAmount('');
      onRefreshBalance();
      window.dispatchEvent(new Event('stellar:tx-update'));
    } catch (error) {
      toast.error(error.message || 'Transaction failed.', { id: toastId });
      setMessage({ tone: 'error', text: error.message || 'Transaction failed.' });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form className="form" onSubmit={handleSend}>
      <div className="form__group recipient">
        <label htmlFor="recipient">Recipient</label>
        <div className="field">
          <Icon name="search" size={16} className="field__icon" />
          <input
            id="recipient"
            ref={recipientRef}
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            onFocus={() => setShowRecent(true)}
            placeholder={`name, name*${DEFAULT_FEDERATION_DOMAIN} or G...`}
            autoComplete="off"
            spellCheck="false"
            required
          />
        </div>
        <RecentAddresses
          addresses={recentAddresses}
          isVisible={showRecent && !recipient}
          onSelect={(value) => {
            setRecipient(value);
            recipientRef.current?.focus();
          }}
          onClear={clearAddresses}
          onClose={closeRecent}
        />
      </div>

      <div className="form__group">
        <label htmlFor="amount">Amount</label>
        <div className="field field--amount">
          <input
            id="amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.0000001"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
            required
          />
          <span className="field__suffix">XLM</span>
        </div>
        <div className="chips">
          {QUICK_AMOUNTS.map((value) => (
            <button key={value} type="button" className="chip chip--button" onClick={() => setAmount(String(value))}>
              {value}
            </button>
          ))}
        </div>
      </div>

      <dl className="summary mono">
        <div>
          <dt>Route</dt>
          <dd>payment_router</dd>
        </div>
        <div>
          <dt>Network fee</dt>
          <dd>~0.00001 XLM</dd>
        </div>
        <div>
          <dt>Settles in</dt>
          <dd>~5s</dd>
        </div>
      </dl>

      <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={isProcessing}>
        {isProcessing ? (
          <>
            <span className="btn__spinner dither-50 spin-steps" aria-hidden="true" /> Processing
          </>
        ) : (
          <>
            Send payment <Icon name="send" size={16} />
          </>
        )}
      </button>
      {message.text && (
        <p className={`notice notice--${message.tone}`} role="status">
          {message.text}
        </p>
      )}
    </form>
  );
}

function ReceivePanel({ receive, onNavigate }) {
  const [copied, setCopied] = useState('');
  const tag = fullTag(receive.tag);

  const copy = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      toast.success(`${label} copied.`);
    } catch {
      toast.error('Copy failed. Select the text and copy it manually.');
    }
  };

  if (receive.loading) {
    return (
      <div className="skeleton-list" aria-busy="true">
        <span className="skeleton dither-12" />
        <span className="skeleton dither-12" />
      </div>
    );
  }

  return (
    <div className="receive">
      <div className="receive__qr">
        <img
          src={`https://api.qrserver.com/v1/create-qr-code/?size=176x176&margin=8&data=${encodeURIComponent(receive.address)}`}
          alt="QR code of your wallet address"
          width="176"
          height="176"
        />
      </div>
      <div className="receive__fields">
        {tag ? (
          <div className="copy-field">
            <span className="eyebrow">Your tag</span>
            <div className="copy-field__row">
              <span className="mono text-paper">{tag}</span>
              <button type="button" className="icon-button" onClick={() => copy(tag, 'Tag')}>
                <Icon name={copied === 'Tag' ? 'check' : 'copy'} size={16} label="Copy tag" />
              </button>
            </div>
          </div>
        ) : (
          <div className="notice notice--info">
            <span>No tag yet. Claim one so people can pay you by name.</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onNavigate('register')}>
              Claim a tag
            </button>
          </div>
        )}
        <div className="copy-field">
          <span className="eyebrow">Wallet address</span>
          <div className="copy-field__row">
            <span className="mono break">{receive.address}</span>
            <button type="button" className="icon-button" onClick={() => copy(receive.address, 'Address')}>
              <Icon name={copied === 'Address' ? 'check' : 'copy'} size={16} label="Copy address" />
            </button>
          </div>
        </div>
        {receive.error && <p className="notice notice--error">{receive.error}</p>}
      </div>
    </div>
  );
}

function Dashboard({
  userPublicKey,
  onConnectWallet,
  balance,
  isRefreshing,
  balanceError,
  onRefreshBalance,
  onNavigate,
  onRegistrationStateChange,
}) {
  const [tab, setTab] = useState('send');
  const [showBalance, setShowBalance] = useState(true);
  const [receiveData, setReceiveData] = useState({ key: '', address: '', tag: '', error: '' });
  const [activityData, setActivityData] = useState({ key: '', rows: [], error: '' });
  const [activityNonce, setActivityNonce] = useState(0);

  useEffect(() => {
    if (!userPublicKey) return undefined;
    let active = true;

    const load = async () => {
      try {
        const response = await fetch(`${API_BASE}/lookup?address=${encodeURIComponent(userPublicKey)}`);
        const rawBody = await response.text();
        const data = rawBody ? JSON.parse(rawBody) : null;
        if (!active) return;

        if (response.ok && data) {
          setReceiveData({ key: userPublicKey, address: data.address, tag: data.username, error: '' });
          onRegistrationStateChange('existing');
          return;
        }
        if (response.status === 404) {
          setReceiveData({ key: userPublicKey, address: userPublicKey, tag: '', error: '' });
          // "skipped", not "new", so the app does not keep redirecting to registration.
          onRegistrationStateChange('skipped');
          return;
        }
        throw new Error(apiErrorMessage(data, `Backend error (${response.status}).`));
      } catch (error) {
        if (!active) return;
        setReceiveData({
          key: userPublicKey,
          address: userPublicKey,
          tag: '',
          error: errorMessage(error, 'Unable to load receive details.'),
        });
        onRegistrationStateChange('unknown');
      }
    };

    load();
    return () => {
      active = false;
    };
  }, [userPublicKey, onRegistrationStateChange]);

  useEffect(() => {
    if (!userPublicKey) return undefined;
    const controller = new AbortController();
    fetchAccountPayments(userPublicKey, { limit: 100, signal: controller.signal })
      .then((rows) => setActivityData({ key: `${userPublicKey}:${activityNonce}`, rows, error: '' }))
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setActivityData({ key: `${userPublicKey}:${activityNonce}`, rows: [], error: errorMessage(error, 'Unable to load activity.') });
      });
    return () => controller.abort();
  }, [userPublicKey, activityNonce]);

  useEffect(() => {
    const bump = () => setActivityNonce((value) => value + 1);
    window.addEventListener('stellar:tx-update', bump);
    return () => window.removeEventListener('stellar:tx-update', bump);
  }, []);

  if (!userPublicKey) {
    return (
      <ConnectPrompt
        onConnectWallet={onConnectWallet}
        title="Connect a wallet to see your balance and send by name."
        body="Any Stellar wallet works: browser extensions, mobile wallets over WalletConnect, and Ledger or Trezor hardware."
      />
    );
  }

  const receive = { ...receiveData, loading: receiveData.key !== userPublicKey };
  const activity = {
    ...activityData,
    loading: !activityData.key.startsWith(`${userPublicKey}:`),
  };
  const parts = balance !== null && balance !== undefined ? splitBalance(balance) : null;

  return (
    <div className="dash">
      <section className="card balance-card">
        <div className="balance-card__head">
          <span className="eyebrow">Available balance</span>
          <div className="row-gap">
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowBalance((value) => !value)}
            >
              <Icon name={showBalance ? 'eyeOff' : 'eye'} size={16} label={showBalance ? 'Hide balance' : 'Show balance'} />
            </button>
            <button
              type="button"
              className={`icon-button ${isRefreshing ? 'is-spinning' : ''}`}
              onClick={onRefreshBalance}
              disabled={isRefreshing}
            >
              <Icon name="refresh" size={16} label="Refresh balance" />
            </button>
          </div>
        </div>
        <p className="balance" aria-live="polite">
          {!showBalance ? (
            <span className="balance__hidden dither-50" aria-label="Balance hidden" />
          ) : parts ? (
            <>
              <span className="balance__whole">{parts.whole}</span>
              <span className="balance__head">.{parts.head}</span>
              <span className="balance__tail">{parts.tail}</span>
              <span className="balance__unit">XLM</span>
            </>
          ) : (
            <span className="balance__whole text-dim">{isRefreshing ? '...' : '--'}</span>
          )}
        </p>
        {balanceError && (
          <p className="notice notice--error">
            {balanceError}{' '}
            {balanceError.includes('not funded') && (
              <a
                href={`https://friendbot.stellar.org/?addr=${userPublicKey}`}
                target="_blank"
                rel="noreferrer"
                onClick={() => setTimeout(onRefreshBalance, 4000)}
              >
                Fund it with Friendbot
              </a>
            )}
          </p>
        )}
        <VolumeBars rows={activity.rows} />
      </section>

      <section className="card pay-card">
        <div className="tabs" role="tablist" aria-label="Payment">
          {['send', 'receive'].map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              className="tabs__tab"
              onClick={() => setTab(id)}
            >
              <Icon name={id} size={16} />
              {id === 'send' ? 'Send' : 'Receive'}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tabs__panel">
          {tab === 'send' ? (
            <SendPanel userPublicKey={userPublicKey} onRefreshBalance={onRefreshBalance} />
          ) : (
            <ReceivePanel receive={receive} onNavigate={onNavigate} />
          )}
        </div>
      </section>

      <section className="card activity-card">
        <div className="card__head">
          <h2 className="h4">Recent activity</h2>
          <span className="chip">Live</span>
        </div>
        <ActivityList state={activity} onNavigate={onNavigate} />
      </section>
    </div>
  );
}

export default Dashboard;

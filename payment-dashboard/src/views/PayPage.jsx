import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import Icon from '../components/Icon';
import { signTransaction } from '../lib/wallets';
import { subscribeToPaymentStatus } from '../lib/paymentEvents';
import {
  assetLabel,
  buildPaymentXdr,
  buildSep7Uri,
  fetchPaymentRequest,
  isValidAmount,
  qrDataUrl,
  readPayLocation,
  requestQrUrl,
  resolveTag,
  submitPayment,
} from '../lib/paymentLinks';
import { errorMessage, formatShortAddress, fullTag } from './shared';

const STATUS_COPY = {
  pending: { label: 'Awaiting payment', tone: '' },
  paid: { label: 'Paid', tone: 'ok' },
  expired: { label: 'Expired', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

const explorerTx = (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

function timeLeft(expiresAt, now) {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

/** Loads what to pay: a saved payment request, or a plain tag link resolved through federation. */
function usePaymentDetails(link) {
  const [state, setState] = useState({ loading: true, error: '', details: null });

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (!link?.tag) {
        setState({ loading: false, error: 'This payment link is missing a tag.', details: null });
        return;
      }
      try {
        if (link.requestId) {
          const request = await fetchPaymentRequest(link.requestId, { signal: controller.signal });
          setState({
            loading: false,
            error: '',
            details: {
              requestId: request.id,
              tag: request.tag,
              destination: request.destination,
              amount: request.amount,
              asset: request.asset || 'XLM',
              memo: request.memo || '',
              memoType: request.memoType || (request.memo ? 'text' : ''),
              description: request.description || '',
              status: request.status,
              expiresAt: request.expiresAt,
              transactionHash: request.transactionHash || '',
            },
          });
          return;
        }
        const resolved = await resolveTag(link.tag, { signal: controller.signal });
        const memo = link.memo || resolved.memo;
        setState({
          loading: false,
          error: '',
          details: {
            requestId: '',
            tag: link.tag,
            destination: resolved.address,
            amount: isValidAmount(link.amount) ? link.amount : '',
            asset: link.asset || 'XLM',
            memo,
            memoType: link.memo ? link.memoType || 'text' : resolved.memoType || (memo ? 'text' : ''),
            description: '',
            status: 'pending',
            expiresAt: null,
            transactionHash: '',
          },
        });
      } catch (error) {
        if (error.name === 'AbortError') return;
        setState({ loading: false, error: errorMessage(error, 'Could not load this payment.'), details: null });
      }
    };
    load();
    return () => controller.abort();
  }, [link]);

  return [state, setState];
}

function QrCard({ details, amount }) {
  const sep7 = useMemo(
    () =>
      details.destination && isValidAmount(amount)
        ? buildSep7Uri({ ...details, amount })
        : '',
    [details, amount],
  );
  const [generated, setGenerated] = useState({ text: '', url: '' });

  useEffect(() => {
    if (details.requestId || !sep7) return undefined;
    let active = true;
    qrDataUrl(sep7)
      .then((url) => active && setGenerated({ text: sep7, url }))
      .catch(() => active && setGenerated({ text: sep7, url: '' }));
    return () => {
      active = false;
    };
  }, [details.requestId, sep7]);

  const src = details.requestId
    ? requestQrUrl(details.requestId, { format: 'sep7', size: 360 })
    : generated.text === sep7
      ? generated.url
      : '';

  return (
    <div className="pay-qr">
      <div className="pay-qr__frame">
        {src ? (
          <img src={src} alt="QR code to pay this request with a Stellar wallet" width="200" height="200" />
        ) : (
          <span className="pay-qr__empty dither-12" aria-hidden="true" />
        )}
      </div>
      <p className="muted small">
        {sep7 ? 'Scan with a Stellar wallet on your phone.' : 'Enter an amount to get a QR code.'}
      </p>
      {sep7 && (
        <a className="btn btn--ghost btn--sm" href={sep7}>
          <Icon name="external" size={14} /> Open in wallet app
        </a>
      )}
    </div>
  );
}

function PayPage({ userPublicKey, onConnectWallet }) {
  const link = useMemo(() => readPayLocation(), []);
  const [{ loading, error, details }, setState] = usePaymentDetails(link);
  const [customAmount, setCustomAmount] = useState('');
  const [phase, setPhase] = useState({ step: 'idle', text: '', hash: '' });
  const [now, setNow] = useState(() => Date.now());

  const requestId = details?.requestId;
  const status = details?.status;

  // Live status for saved requests: paid, cancelled or expired elsewhere.
  useEffect(() => {
    if (!requestId || status !== 'pending') return undefined;
    const apply = (data) => {
      if (!data?.status) return;
      setState((prev) =>
        prev.details
          ? {
              ...prev,
              details: {
                ...prev.details,
                status: data.status,
                transactionHash: data.transactionHash || prev.details.transactionHash,
              },
            }
          : prev,
      );
    };
    return subscribeToPaymentStatus(requestId, { onSnapshot: apply, onUpdate: apply });
  }, [requestId, status, setState]);

  // Ticks the expiry countdown while a request is open.
  useEffect(() => {
    if (!details?.expiresAt || status !== 'pending') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [details?.expiresAt, status]);

  if (loading) {
    return (
      <div className="pay-page">
        <section className="card" aria-busy="true">
          <div className="skeleton-list">
            <span className="skeleton dither-12" />
            <span className="skeleton dither-12" />
            <span className="skeleton dither-12" />
          </div>
        </section>
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="pay-page">
        <section className="card">
          <h2 className="h3">Payment link not available</h2>
          <p className="notice notice--error">{error || 'This payment link is not valid.'}</p>
          <a className="btn btn--ghost" href="/">
            Go to Stellar Tags
          </a>
        </section>
      </div>
    );
  }

  const expiredLocally =
    status === 'pending' && details.expiresAt && new Date(details.expiresAt).getTime() <= now;
  const effectiveStatus = expiredLocally ? 'expired' : status;
  const amount = details.amount || customAmount.trim();
  const amountOk = isValidAmount(amount);
  const isOwnRequest = userPublicKey && userPublicKey === details.destination;
  const busy = phase.step === 'working';
  const sent = phase.step === 'sent';
  const canPay = effectiveStatus === 'pending' && !sent && amountOk && !isOwnRequest;
  const statusCopy = STATUS_COPY[effectiveStatus] || STATUS_COPY.pending;
  const paidHash = details.transactionHash || phase.hash;

  const handlePay = async () => {
    if (!canPay || busy) return;
    let payer = userPublicKey;
    if (!payer) {
      const result = await onConnectWallet();
      if (!result?.ok) return;
      payer = result.address;
    }
    if (payer === details.destination) {
      toast.error('This request is to your own wallet. Connect a different wallet to pay it.');
      return;
    }

    const toastId = toast.loading('Preparing the payment...');
    try {
      setPhase({ step: 'working', text: 'Preparing the payment...', hash: '' });
      const xdr = await buildPaymentXdr({
        source: payer,
        destination: details.destination,
        amount,
        asset: details.asset,
        memo: details.memo,
        memoType: details.memoType,
      });

      setPhase({ step: 'working', text: 'Approve the payment in your wallet...', hash: '' });
      toast.loading('Approve the payment in your wallet...', { id: toastId });
      let signed;
      try {
        signed = await signTransaction(xdr, payer);
      } catch (err) {
        throw new Error(`Wallet signature failed: ${err?.message || 'rejected'}`, { cause: err });
      }

      setPhase({ step: 'working', text: 'Sending to the network...', hash: '' });
      toast.loading('Sending to the network...', { id: toastId });
      const hash = await submitPayment(signed);

      setPhase({ step: 'sent', text: '', hash });
      toast.success(`Sent ${amount} ${assetLabel(details.asset)}.`, { id: toastId });
      window.dispatchEvent(new Event('stellar:tx-update'));
    } catch (err) {
      const text = err?.message || 'The payment failed.';
      setPhase({ step: 'error', text, hash: '' });
      toast.error(text, { id: toastId });
    }
  };

  const remaining = details.expiresAt && effectiveStatus === 'pending' ? timeLeft(details.expiresAt, now) : '';
  const showQr = effectiveStatus === 'pending' && !sent;

  return (
    <div className="pay-page">
      <section className={`card pay-sheet${showQr ? '' : ' pay-sheet--single'}`}>
        <div className="pay-sheet__main">
          <div className="pay-sheet__head">
            <span className="eyebrow">{details.requestId ? 'Payment request' : 'Pay by tag'}</span>
            {details.requestId && (
              <span className={`chip pay-status ${statusCopy.tone ? `pay-status--${statusCopy.tone}` : ''}`}>
                <span className={`dot ${statusCopy.tone === 'ok' ? 'dot--blue' : statusCopy.tone === 'danger' ? 'dot--danger' : ''}`} aria-hidden="true" />
                {statusCopy.label}
              </span>
            )}
          </div>

          <div className="pay-to">
            <span className="muted small">Pay</span>
            <span className="pay-to__tag mono">{fullTag(details.tag)}</span>
            <span className="mono muted small" title={details.destination}>
              {formatShortAddress(details.destination)}
            </span>
          </div>

          {details.amount ? (
            <p className="pay-amount" aria-label={`${details.amount} ${assetLabel(details.asset)}`}>
              <span className="pay-amount__value">{details.amount}</span>
              <span className="pay-amount__unit">{assetLabel(details.asset)}</span>
            </p>
          ) : (
            <div className="form__group">
              <label htmlFor="pay-amount">Amount</label>
              <div className="field field--amount">
                <input
                  id="pay-amount"
                  inputMode="decimal"
                  value={customAmount}
                  onChange={(event) => setCustomAmount(event.target.value)}
                  placeholder="0.00"
                  autoComplete="off"
                  disabled={busy || sent}
                />
                <span className="field__suffix">{assetLabel(details.asset)}</span>
              </div>
              {customAmount && !amountOk && (
                <p className="text-danger small">Enter a positive amount with at most 7 decimal places.</p>
              )}
            </div>
          )}

          {details.description && <p className="pay-note">{details.description}</p>}

          <dl className="summary mono">
            {details.memo && (
              <div>
                <dt>Memo</dt>
                <dd className="break">{details.memo}</dd>
              </div>
            )}
            <div>
              <dt>Network</dt>
              <dd>Stellar testnet</dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>~0.00001 XLM</dd>
            </div>
            {remaining && (
              <div>
                <dt>Expires in</dt>
                <dd>{remaining}</dd>
              </div>
            )}
          </dl>

          {effectiveStatus === 'paid' ? (
            <div className="notice notice--ok" role="status">
              This request has been paid.{' '}
              {paidHash && (
                <a href={explorerTx(paidHash)} target="_blank" rel="noopener noreferrer">
                  View transaction
                </a>
              )}
            </div>
          ) : effectiveStatus === 'expired' || effectiveStatus === 'cancelled' ? (
            <p className="notice notice--error" role="status">
              This request was {effectiveStatus === 'expired' ? 'not paid in time and has expired' : 'cancelled by the recipient'}. Ask
              them for a new link.
            </p>
          ) : sent ? (
            <div className="notice notice--ok" role="status">
              Payment sent.{' '}
              {details.requestId ? 'Waiting for Stellar Tags to confirm it, this takes a few seconds. ' : ''}
              <a href={explorerTx(phase.hash)} target="_blank" rel="noopener noreferrer">
                View transaction
              </a>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--primary btn--lg btn--block"
                onClick={handlePay}
                disabled={!canPay || busy}
              >
                {busy ? (
                  <>
                    <span className="btn__spinner dither-50 spin-steps" aria-hidden="true" /> {phase.text}
                  </>
                ) : userPublicKey ? (
                  <>
                    Pay {amountOk ? `${amount} ${assetLabel(details.asset)}` : ''} <Icon name="send" size={16} />
                  </>
                ) : (
                  <>
                    <Icon name="wallet" size={16} /> Connect wallet to pay
                  </>
                )}
              </button>
              {isOwnRequest && (
                <p className="notice notice--info">
                  This request is to your own wallet. Share the link with the person paying you.
                </p>
              )}
              {phase.step === 'error' && (
                <p className="notice notice--error" role="alert">
                  {phase.text}
                </p>
              )}
            </>
          )}
        </div>

        {showQr && <QrCard details={details} amount={amount} />}
      </section>
    </div>
  );
}

export default PayPage;

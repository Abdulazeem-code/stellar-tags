import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Icon from './Icon';
import { connectedWalletId, normaliseSignature, signMessage, walletName } from '../lib/wallets';
import { buildPayLink, isValidAmount, qrDataUrl } from '../lib/paymentLinks';
import { API_BASE, DEFAULT_FEDERATION_DOMAIN, apiErrorMessage } from '../views/shared';

const EXPIRY_OPTIONS = [
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
];

/** The tag exactly as the API signs it: name*domain, lower case. */
const signedTag = (tag) => {
  const value = tag.trim().toLowerCase();
  return value.includes('*') ? value : `${value}*${DEFAULT_FEDERATION_DOMAIN}`;
};

function CreatedRequest({ created, onReset }) {
  const [qr, setQr] = useState('');

  useEffect(() => {
    let active = true;
    qrDataUrl(created.link)
      .then((url) => active && setQr(url))
      .catch(() => active && setQr(''));
    return () => {
      active = false;
    };
  }, [created.link]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.link);
      toast.success('Link copied.');
    } catch {
      toast.error('Copy failed. Select the link and copy it manually.');
    }
  };

  return (
    <div className="request-result">
      <div className="receive__qr">
        {qr ? (
          <img src={qr} alt="QR code that opens this payment request" width="176" height="176" />
        ) : (
          <span className="pay-qr__empty dither-12" aria-hidden="true" />
        )}
      </div>
      <div className="receive__fields">
        <div className="copy-field">
          <span className="eyebrow">
            Request for {created.amount} XLM
          </span>
          <div className="copy-field__row">
            <span className="mono break small">{created.link}</span>
            <button type="button" className="icon-button" onClick={copy}>
              <Icon name="copy" size={16} label="Copy payment link" />
            </button>
          </div>
        </div>
        <div className="row-gap">
          <a className="btn btn--ghost btn--sm" href={created.link} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={14} /> Open pay page
          </a>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onReset}>
            <Icon name="plus" size={14} /> New request
          </button>
        </div>
      </div>
    </div>
  );
}

function RequestPaymentForm({ tag, address }) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [expiry, setExpiry] = useState('24h');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  if (created) return <CreatedRequest created={created} onReset={() => setCreated(null)} />;

  const amountValue = amount.trim();
  const amountProblem = amountValue && !isValidAmount(amountValue)
    ? 'Enter a positive amount with at most 7 decimal places.'
    : '';

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!isValidAmount(amountValue)) {
      setError('Enter a positive amount with at most 7 decimal places.');
      return;
    }
    setBusy(true);
    setError('');

    const fullTag = signedTag(tag);
    let signature;
    try {
      signature = normaliseSignature(await signMessage(`payment-request:${fullTag}`, address));
      if (!signature) throw new Error('The wallet did not return a signature.');
    } catch (err) {
      const text = String(err?.message || '');
      setError(
        text.includes('signMessage') || text.toLowerCase().includes('not supported')
          ? `${walletName(connectedWalletId())} cannot sign messages. Connect Freighter, xBull, Albedo, Hana or Rabet to create requests.`
          : text || 'Signature request cancelled.',
      );
      setBusy(false);
      return;
    }

    try {
      const option = EXPIRY_OPTIONS.find((item) => item.id === expiry) || EXPIRY_OPTIONS[1];
      const response = await fetch(`${API_BASE}/payment-requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          'X-Stellar-Signature': signature,
          'X-Stellar-Signer': address,
        },
        body: JSON.stringify({
          tag: fullTag,
          amount: amountValue,
          asset: 'XLM',
          expiresAt: new Date(Date.now() + option.ms).toISOString(),
          ...(description.trim() && { description: description.trim() }),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.data) {
        throw new Error(apiErrorMessage(body, `Could not create the request (${response.status}).`));
      }
      const data = body.data;
      setCreated({
        id: data.id,
        amount: data.amount,
        link: buildPayLink({
          tag: data.tag,
          amount: data.amount,
          asset: data.asset,
          memo: data.memo,
          memoType: data.memoType,
          requestId: data.id,
        }),
      });
      setAmount('');
      setDescription('');
      toast.success('Payment request created.');
    } catch (err) {
      setError(err?.message || 'Could not create the request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form request-form" onSubmit={handleSubmit}>
      <div className="card__head">
        <h3 className="h4">Request a payment</h3>
      </div>
      <p className="muted small">
        Get a link and QR code for a set amount. It turns to paid on its own when the money arrives.
      </p>

      <div className="form__group">
        <label htmlFor="request-amount">Amount</label>
        <div className="field field--amount">
          <input
            id="request-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
            autoComplete="off"
            required
          />
          <span className="field__suffix">XLM</span>
        </div>
        {amountProblem && <p className="text-danger small">{amountProblem}</p>}
      </div>

      <div className="form__group">
        <label htmlFor="request-note">
          What it is for <span className="muted">(optional)</span>
        </label>
        <div className="field">
          <input
            id="request-note"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={140}
            placeholder="Dinner on Friday"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="form__group">
        <span className="label" id="request-expiry-label">Expires after</span>
        <div className="segmented" role="group" aria-labelledby="request-expiry-label">
          {EXPIRY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={expiry === option.id}
              onClick={() => setExpiry(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        {busy ? (
          <>
            <span className="btn__spinner dither-50 spin-steps" aria-hidden="true" /> Creating request
          </>
        ) : (
          <>
            <Icon name="plus" size={16} /> Create payment link
          </>
        )}
      </button>
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export default RequestPaymentForm;

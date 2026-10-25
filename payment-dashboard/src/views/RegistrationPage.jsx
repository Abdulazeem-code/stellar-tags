import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Icon from '../components/Icon';
import { useDebounce } from '../useDebounce';
import { checkTag, validateTag, TAG_MAX } from '../lib/tags';
import { signMessage, walletName, connectedWalletId } from '../lib/wallets';
import {
  API_BASE,
  DEFAULT_FEDERATION_DOMAIN,
  apiErrorMessage,
  formatShortAddress,
  fullTag,
} from './shared';

const MEMO_PLACEHOLDER = {
  text: 'Up to 28 characters',
  id: '64-bit unsigned integer',
  hash: '64-character hex string',
};

// Wallets return the signature as a base64 string, a Buffer-like object or a
// Uint8Array depending on the wallet. The API wants base64.
function normaliseSignature(result) {
  if (result && result.error) throw new Error(result.error.message || result.error);
  const raw = typeof result === 'string' ? result : result?.signedMessage || result?.signature;
  if (!raw || typeof raw !== 'object') return raw;

  let bytes;
  if (raw.type === 'Buffer' && Array.isArray(raw.data)) {
    bytes = new Uint8Array(raw.data);
  } else if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (raw.buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw.buffer);
  } else {
    bytes = new Uint8Array(Object.values(raw));
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  // Some wallets hand back the ASCII bytes of an already base64 signature.
  if (binary.length >= 80 && binary.length <= 90 && /^[a-zA-Z0-9+/]+={0,2}$/.test(binary)) {
    return binary;
  }
  return btoa(binary);
}

function validateMemo(memoType, memo) {
  if (memoType && !memo) return 'Enter a memo value, or set the type back to None.';
  if (!memoType && memo) return 'Pick a memo type.';
  if (memoType === 'text' && memo.length > 28) return 'Text memos are at most 28 characters.';
  if (memoType === 'id' && !/^\d+$/.test(memo)) return 'ID memos are whole numbers.';
  if (memoType === 'hash' && !/^[0-9a-fA-F]{64}$/.test(memo)) return 'Hash memos are 64 hex characters.';
  return '';
}

function ExistingTag({ tag, address, onDone }) {
  const full = fullTag(tag);
  return (
    <section className="card claimed">
      <div className="claimed__bands" aria-hidden="true">
        <span className="dither-blue-12" />
        <span className="dither-blue-25" />
        <span className="dither-blue-50" />
      </div>
      <p className="eyebrow eyebrow--blue">
        <Icon name="check" size={14} /> Registered
      </p>
      <h2 className="claimed__tag mono">{full}</h2>
      <p className="muted">
        Resolves to <span className="mono text-paper">{formatShortAddress(address)}</span>. Anyone can pay
        you with this name from any app that supports Stellar federation.
      </p>
      <div className="row-gap">
        <button
          type="button"
          className="btn btn--primary"
          onClick={async () => {
            await navigator.clipboard.writeText(full);
            toast.success('Tag copied.');
          }}
        >
          <Icon name="copy" size={16} /> Copy tag
        </button>
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          Go to dashboard <Icon name="arrow" size={16} />
        </button>
      </div>
    </section>
  );
}

function RegistrationPage({ userPublicKey, onConnectWallet, onRegistered, onDone }) {
  const [username, setUsername] = useState('');
  const debounced = useDebounce(username, 350);
  const [availability, setAvailability] = useState({ state: 'idle', text: 'Type a name to check' });
  const [memoType, setMemoType] = useState('');
  const [memo, setMemo] = useState('');
  const [memoError, setMemoError] = useState('');
  const [status, setStatus] = useState({ tone: '', text: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [existing, setExisting] = useState({ key: '', tag: '' });

  useEffect(() => {
    if (!userPublicKey) return undefined;
    let active = true;
    fetch(`${API_BASE}/lookup?address=${encodeURIComponent(userPublicKey)}`)
      .then(async (response) => {
        const data = response.ok ? await response.json().catch(() => null) : null;
        if (active) setExisting({ key: userPublicKey, tag: data?.username || '' });
      })
      .catch(() => active && setExisting({ key: userPublicKey, tag: '' }));
    return () => {
      active = false;
    };
  }, [userPublicKey]);

  useEffect(() => {
    const controller = new AbortController();
    checkTag(debounced, { signal: controller.signal })
      .then((next) => setAvailability({ ...next, for: debounced }))
      .catch(() => {});
    return () => controller.abort();
  }, [debounced]);

  const cleaned = username.trim();
  const ruleError = validateTag(cleaned);
  // Still typing, or the request for the latest name has not answered yet
  // (the API can take a while to wake up).
  const checking = Boolean(cleaned) && (cleaned !== debounced.trim() || availability.for !== debounced);
  const shown = checking ? { state: 'checking', text: 'Checking...' } : availability;
  const full = `${(cleaned || 'yourname').toLowerCase()}*${DEFAULT_FEDERATION_DOMAIN}`;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;

    let address = userPublicKey;
    if (!address) {
      const result = await onConnectWallet();
      if (!result?.ok) return;
      address = result.address;
    }

    if (!cleaned || ruleError) {
      setStatus({ tone: 'error', text: ruleError || 'Pick a username first.' });
      return;
    }
    if (checking) {
      setStatus({ tone: 'error', text: 'Still checking that name. Try again in a moment.' });
      return;
    }
    if (availability.state === 'taken') {
      setStatus({ tone: 'error', text: `${full} is already taken.` });
      return;
    }
    const memoProblem = validateMemo(memoType, memo);
    setMemoError(memoProblem);
    if (memoProblem) return;

    setIsSubmitting(true);
    setStatus({ tone: '', text: `Approve the signature request in ${walletName(connectedWalletId())}...` });

    let signature;
    try {
      const message = `register:${cleaned.toLowerCase()}:${address}`;
      signature = normaliseSignature(await signMessage(message, address));
      if (!signature) throw new Error('The wallet did not return a signature.');
    } catch (err) {
      const text = String(err?.message || '');
      setStatus({
        tone: 'error',
        text:
          text.includes('signMessage') || text.toLowerCase().includes('not supported')
            ? `${walletName(connectedWalletId())} cannot sign messages yet. Connect Freighter, xBull, Albedo, Hana or Rabet to claim a tag.`
            : text || 'Signature request cancelled.',
      });
      setIsSubmitting(false);
      return;
    }

    setStatus({ tone: '', text: 'Saving your tag...' });
    try {
      const response = await fetch(`${API_BASE}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: cleaned.toLowerCase(),
          address,
          signature,
          signerAddress: address,
          ...(memoType && memo && { memo_type: memoType, memo }),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(data, 'Registration failed.'));

      setStatus({ tone: 'ok', text: `${full} is yours.` });
      toast.success(`${full} is yours.`);
      setExisting({ key: address, tag: cleaned.toLowerCase() });
      onRegistered?.();
    } catch (error) {
      setStatus({ tone: 'error', text: error.message || 'Registration failed.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (userPublicKey && existing.key === userPublicKey && existing.tag) {
    return <ExistingTag tag={existing.tag} address={userPublicKey} onDone={onDone} />;
  }

  return (
    <div className="register">
      <form className="card form register__form" onSubmit={handleSubmit} noValidate>
        <div>
          <p className="eyebrow eyebrow--blue">Step 2 of 3</p>
          <h2 className="h3">Claim a name people can pay.</h2>
          <p className="muted">
            Letters and numbers, 3 to {TAG_MAX} characters. Your wallet signs a message to prove the
            address is yours. No fee, no transaction.
          </p>
        </div>

        <div className="form__group">
          <label htmlFor="username">Username</label>
          <div className={`field field--joined ${ruleError ? 'is-invalid' : ''}`}>
            <input
              id="username"
              value={username}
              onChange={(event) => setUsername(event.target.value.replace(/\s/g, ''))}
              placeholder="yourname"
              autoComplete="off"
              spellCheck="false"
              maxLength={TAG_MAX}
              aria-describedby="username-status"
              aria-invalid={Boolean(ruleError)}
            />
            <span className="field__suffix">*{DEFAULT_FEDERATION_DOMAIN}</span>
          </div>
          <p id="username-status" className={`tag-check__status tag-check__status--${shown.state}`} aria-live="polite">
            <span className="dot" aria-hidden="true" />
            {shown.text}
          </p>
        </div>

        <details className="disclosure">
          <summary>
            Default memo <span className="muted">(optional, for exchanges)</span>
          </summary>
          <div className="form__row">
            <div className="form__group">
              <label htmlFor="memo-type">Memo type</label>
              <select
                id="memo-type"
                className="select"
                value={memoType}
                onChange={(event) => {
                  setMemoType(event.target.value);
                  setMemo('');
                  setMemoError('');
                }}
              >
                <option value="">None</option>
                <option value="text">Text</option>
                <option value="id">ID</option>
                <option value="hash">Hash</option>
              </select>
            </div>
            {memoType && (
              <div className="form__group">
                <label htmlFor="memo-value">
                  Memo value
                  {memoType === 'text' && <span className="muted mono"> {memo.length}/28</span>}
                </label>
                <div className="field">
                  <input
                    id="memo-value"
                    value={memo}
                    maxLength={memoType === 'text' ? 28 : undefined}
                    placeholder={MEMO_PLACEHOLDER[memoType]}
                    onChange={(event) => {
                      setMemo(event.target.value);
                      setMemoError('');
                    }}
                    aria-invalid={Boolean(memoError)}
                  />
                </div>
              </div>
            )}
          </div>
          {memoError && <p className="notice notice--error" role="alert">{memoError}</p>}
        </details>

        <button
          type="submit"
          className="btn btn--primary btn--lg btn--block"
          disabled={isSubmitting || (Boolean(userPublicKey) && (Boolean(ruleError) || availability.state === 'taken'))}
        >
          {isSubmitting ? (
            <>
              <span className="btn__spinner dither-50 spin-steps" aria-hidden="true" /> Waiting for wallet
            </>
          ) : userPublicKey ? (
            <>
              Sign and claim <Icon name="arrow" size={16} />
            </>
          ) : (
            <>
              <Icon name="wallet" size={16} /> Connect wallet to claim
            </>
          )}
        </button>
        {status.text && (
          <p className={`notice notice--${status.tone || 'info'}`} role="status">
            {status.text}
          </p>
        )}
      </form>

      <aside className="card preview">
        <span className="eyebrow">Preview</span>
        <div className="preview__card dither-frame">
          <span className="mono text-dim">STELLAR/TAGS</span>
          <strong className="preview__tag mono">{full}</strong>
          <span className="mono text-blue">
            {userPublicKey ? formatShortAddress(userPublicKey) : 'G... your wallet'}
          </span>
        </div>
        <ol className="preview__steps">
          <li className={userPublicKey ? 'is-done' : ''}>
            <span className="mono">01</span> Connect wallet
            {userPublicKey && <Icon name="check" size={14} className="text-blue" />}
          </li>
          <li className={cleaned && !ruleError ? 'is-done' : ''}>
            <span className="mono">02</span> Pick a name
          </li>
          <li>
            <span className="mono">03</span> Sign once to prove ownership
          </li>
        </ol>
        <p className="muted small">
          Tags resolve through SEP-0002 federation, so wallets and exchanges that support it can pay
          you by name too.
        </p>
      </aside>
    </div>
  );
}

export default RegistrationPage;

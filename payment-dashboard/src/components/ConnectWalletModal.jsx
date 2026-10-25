import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { WALLET_HINTS, connectWallet, detectWallets } from '../lib/wallets';

function WalletButton({ wallet, selected, onPick, compact }) {
  const disabled = Boolean(wallet.disabledReason);
  return (
    <button
      type="button"
      className={`wallet-option ${compact ? 'wallet-option--compact' : ''} ${selected ? 'is-selected' : ''}`}
      onClick={() => onPick(wallet)}
      disabled={disabled}
      title={wallet.disabledReason || undefined}
    >
      <span className={`wallet-option__mark ${selected ? 'dither-blue-50' : 'dither-25'}`}>
        {wallet.icon && (
          <img src={wallet.icon} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />
        )}
      </span>
      <span className="wallet-option__text">
        <span className="wallet-option__name">{wallet.name}</span>
        {!compact && <span className="wallet-option__kind">{wallet.kind}</span>}
        {disabled && <span className="wallet-option__kind">{wallet.disabledReason}</span>}
      </span>
    </button>
  );
}

/**
 * Wallet picker for every wallet the Stellar Wallets Kit supports. Installed
 * extensions are listed first; the right pane walks the person through the
 * approval and shows wallet errors in place. Mount it only while open, so
 * each opening starts from a clean state.
 */
export default function ConnectWalletModal({ onClose, onConnected }) {
  const [wallets, setWallets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const dialogRef = useRef(null);

  useEffect(() => {
    let active = true;
    detectWallets()
      .then((list) => active && setWallets(list))
      .catch(() => active && setWallets([]));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.querySelector('button')?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll('button:not([disabled]), a[href]');
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
      previous?.focus?.();
    };
  }, [onClose]);

  const pick = async (wallet) => {
    setSelected(wallet);
    setError('');
    setPhase('connecting');
    try {
      const address = await connectWallet(wallet.id);
      setPhase('done');
      onConnected(address, wallet.id);
    } catch (err) {
      setPhase('error');
      setError(err?.message || err?.error?.message || 'The wallet closed without connecting.');
    }
  };

  const detected = wallets.filter((wallet) => wallet.detect && wallet.isAvailable);
  const more = wallets.filter((wallet) => !(wallet.detect && wallet.isAvailable));

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className="connect-modal pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
      >
        <div className="connect-modal__list">
          <div className="connect-modal__head">
            <h2 id="connect-title">Connect a wallet</h2>
            <span className="chip">Testnet</span>
          </div>
          {wallets.length === 0 && <p className="connect-modal__label">Looking for wallets...</p>}
          {detected.length > 0 && (
            <>
              <p className="connect-modal__label">Detected</p>
              <div className="connect-modal__stack">
                {detected.map((wallet) => (
                  <WalletButton
                    key={wallet.id}
                    wallet={wallet}
                    selected={selected?.id === wallet.id}
                    onPick={pick}
                  />
                ))}
              </div>
            </>
          )}
          {more.length > 0 && (
            <>
              <p className="connect-modal__label">{detected.length ? 'More options' : 'Wallets'}</p>
              <div className="connect-modal__grid">
                {more.map((wallet) => (
                  <WalletButton
                    key={wallet.id}
                    wallet={wallet}
                    selected={selected?.id === wallet.id}
                    onPick={pick}
                    compact
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="connect-modal__side">
          <button type="button" className="icon-button connect-modal__close" onClick={onClose}>
            <Icon name="close" label="Close" />
          </button>
          {phase === 'idle' && (
            <div className="connect-modal__state">
              <p className="eyebrow">New to Stellar?</p>
              <h3>A wallet holds your keys. We never see them.</h3>
              <p className="muted">
                Pick any wallet. Freighter is the quickest start on desktop and LOBSTR on mobile.
                Installed extensions show up under Detected.
              </p>
            </div>
          )}
          {selected && phase !== 'idle' && (
            <div className="connect-modal__state" aria-live="polite">
              <div
                className={`connect-modal__spinner ${phase === 'error' ? 'dither-25' : 'dither-blue-50 spin-steps'}`}
                aria-hidden="true"
              />
              <p className={`eyebrow ${phase === 'error' ? 'text-danger' : ''}`}>
                {phase === 'connecting' && 'Connecting'}
                {phase === 'done' && 'Connected'}
                {phase === 'error' && 'Not connected'}
              </p>
              <h3>
                {phase === 'error' ? `${selected.name} did not connect` : `Opening ${selected.name}`}
              </h3>
              <p className="muted">{phase === 'error' ? error : WALLET_HINTS[selected.id]}</p>
              {phase === 'connecting' && (
                <div className="load-bar" aria-hidden="true">
                  <div className="load-bar__fill dither-25" />
                </div>
              )}
              <div className="row-gap">
                <button type="button" className="btn btn--ghost" onClick={() => setPhase('idle')}>
                  Back
                </button>
                {phase === 'error' && (
                  <button type="button" className="btn btn--primary" onClick={() => pick(selected)}>
                    Try again
                  </button>
                )}
                {phase === 'error' && selected.url && (
                  <a className="btn btn--ghost" href={selected.url} target="_blank" rel="noreferrer">
                    Get {selected.name} <Icon name="external" size={14} />
                  </a>
                )}
              </div>
            </div>
          )}
          <p className="connect-modal__fine">
            Stellar Tags only asks your wallet for your public key and for signatures you approve.
          </p>
        </div>
      </div>
    </div>
  );
}

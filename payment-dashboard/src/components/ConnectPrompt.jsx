import DitherSphere from './DitherSphere';
import Icon from './Icon';

/** Shown in place of a view's content until a wallet is connected. */
export default function ConnectPrompt({ onConnectWallet, title, body }) {
  return (
    <section className="card empty-state">
      <div className="empty-state__art" aria-hidden="true">
        <DitherSphere resolution={84} />
      </div>
      <div className="empty-state__copy">
        <p className="eyebrow eyebrow--blue">Wallet not connected</p>
        <h2 className="h3">{title}</h2>
        <p className="muted">{body}</p>
        <button type="button" className="btn btn--primary" onClick={onConnectWallet}>
          <Icon name="wallet" size={16} /> Connect wallet
        </button>
      </div>
    </section>
  );
}

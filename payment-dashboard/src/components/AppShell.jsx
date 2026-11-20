import toast from 'react-hot-toast';
import Icon, { BrandMark } from './Icon';
import NetworkBadge from '../NetworkBadge';
import LatencyGauge from '../LatencyGauge';
import { useLatencyTracker } from '../useLatencyTracker';
import { API_BASE, formatShortAddress, useWalletMenu } from '../views/shared';
import { walletName } from '../lib/wallets';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', short: 'Home', icon: 'home' },
  { id: 'history', label: 'History', short: 'History', icon: 'history' },
  { id: 'analytics', label: 'Analytics', short: 'Stats', icon: 'chart' },
  { id: 'register', label: 'My tag', short: 'Tag', icon: 'tag' },
  { id: 'help', label: 'Help', short: 'Help', icon: 'help' },
];

function WalletMenu({ userPublicKey, walletId, onConnect, onDisconnect }) {
  const { menuRef, isOpen, setIsOpen } = useWalletMenu();

  if (!userPublicKey) {
    return (
      <button type="button" className="btn btn--primary" onClick={onConnect}>
        <Icon name="wallet" size={16} />
        Connect wallet
      </button>
    );
  }

  return (
    <div className="wallet-menu" ref={menuRef}>
      <button
        type="button"
        className="wallet-pill"
        onClick={() => setIsOpen((value) => !value)}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <span className="dot dot--blue" aria-hidden="true" />
        <span className="wallet-pill__name">{walletName(walletId)}</span>
        <span className="mono">{formatShortAddress(userPublicKey)}</span>
      </button>
      {isOpen && (
        <div className="menu pop-in" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              await navigator.clipboard.writeText(userPublicKey);
              toast.success('Address copied.');
              setIsOpen(false);
            }}
          >
            <Icon name="copy" size={16} /> Copy address
          </button>
          <a
            role="menuitem"
            href={`https://stellar.expert/explorer/testnet/account/${userPublicKey}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setIsOpen(false)}
          >
            <Icon name="external" size={16} /> View on Stellar Expert
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onConnect();
            }}
          >
            <Icon name="wallet" size={16} /> Switch wallet
          </button>
          <button
            type="button"
            role="menuitem"
            className="text-danger"
            onClick={() => {
              setIsOpen(false);
              onDisconnect();
            }}
          >
            <Icon name="logout" size={16} /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Layout for every signed-in view: side rail on desktop, bottom tab bar on
 * phones, and a top bar with network status and the wallet menu.
 */
export default function AppShell({
  active,
  onNavigate,
  userPublicKey,
  walletId,
  onConnect,
  onDisconnect,
  eyebrow,
  title,
  actions,
  children,
}) {
  const latency = useLatencyTracker(API_BASE);

  const go = (event, id) => {
    event.preventDefault();
    onNavigate(id);
  };

  return (
    <div className="shell">
      <aside className="shell__rail">
        <a href="#" className="brand" onClick={(event) => go(event, 'home')}>
          <BrandMark />
          <span className="brand__word">STELLAR/TAGS</span>
        </a>
        <nav className="rail-nav" aria-label="App">
          {NAV.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="rail-nav__link"
              aria-current={active === item.id ? 'page' : undefined}
              onClick={(event) => go(event, item.id)}
            >
              <Icon name={item.icon} size={16} />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="pulse-card">
          <span className="eyebrow">Network pulse</span>
          <LatencyGauge latency={latency.latency} status={latency.status} />
          <div className="pulse-card__bar dither-25 tick" aria-hidden="true" />
          <NetworkBadge />
        </div>
      </aside>

      <div className="shell__main">
        <header className="topbar">
          <a href="#" className="brand brand--compact" onClick={(event) => go(event, 'home')}>
            <BrandMark />
            <span className="brand__word">STELLAR/TAGS</span>
          </a>
          <div className="topbar__title">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h1>{title}</h1>
          </div>
          <div className="topbar__actions">
            {actions}
            <span className="hide-sm">
              <NetworkBadge />
            </span>
            <WalletMenu
              userPublicKey={userPublicKey}
              walletId={walletId}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
            />
          </div>
        </header>
        <main className="shell__content" id="main">
          {children}
        </main>
      </div>

      <nav className="tabbar" aria-label="Primary">
        {NAV.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            aria-current={active === item.id ? 'page' : undefined}
            onClick={(event) => go(event, item.id)}
          >
            <Icon name={item.icon} size={18} />
            <span>{item.short}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

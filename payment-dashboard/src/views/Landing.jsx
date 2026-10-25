import { useEffect, useState } from 'react';
import DitherSphere from '../components/DitherSphere';
import Icon, { BrandMark } from '../components/Icon';
import { useDebounce } from '../useDebounce';
import { API_BASE, CONTRACT_ID, DEFAULT_FEDERATION_DOMAIN } from './shared';
import { WALLETS } from '../lib/wallets';
import { checkTag } from '../lib/tags';

const TICKER = [
  'Testnet live',
  'Ledger close about 5s',
  'Base fee 0.00001 XLM',
  'Routed by Soroban payment_router',
  'name*domain federation',
  'Non-custodial',
];

const STEPS = [
  {
    n: '01',
    title: 'Connect any wallet',
    body: 'Freighter, xBull, LOBSTR, Albedo, Rabet, Hana, HOT, Ledger, Trezor or WalletConnect. Your keys never leave them.',
    icon: 'wallet',
  },
  {
    n: '02',
    title: 'Claim your tag',
    body: 'Pick a handle. It is bound to your address, so anyone who knows your name can pay you.',
    icon: 'tag',
  },
  {
    n: '03',
    title: 'Send by name',
    body: 'Type a tag, enter an amount, sign. The router resolves it and the ledger settles in about five seconds.',
    icon: 'send',
  },
];

function TagChecker({ onNavigate }) {
  const [tag, setTag] = useState('');
  const debounced = useDebounce(tag, 350);
  const [result, setResult] = useState({ state: 'idle', text: 'Type a name to check' });

  useEffect(() => {
    let active = true;
    checkTag(debounced).then((next) => active && setResult({ ...next, for: debounced }));
    return () => {
      active = false;
    };
  }, [debounced]);

  const pending = Boolean(tag.trim()) && (tag !== debounced || result.for !== debounced);
  const shown = pending ? { state: 'checking', text: 'Checking...' } : result;

  return (
    <form
      className="tag-check"
      onSubmit={(event) => {
        event.preventDefault();
        onNavigate('register');
      }}
    >
      <label htmlFor="tagcheck" className="eyebrow">
        Check a tag
      </label>
      <div className="field field--joined">
        <input
          id="tagcheck"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder="yourname"
          autoComplete="off"
          spellCheck="false"
          maxLength={20}
        />
        <span className="field__suffix">*{DEFAULT_FEDERATION_DOMAIN}</span>
        <button type="submit" className="btn btn--primary">
          Claim <Icon name="arrow" size={16} />
        </button>
      </div>
      <p className={`tag-check__status tag-check__status--${shown.state}`} aria-live="polite">
        <span className="dot" aria-hidden="true" />
        {shown.text}
      </p>
    </form>
  );
}

function HatchPlanet({ className, style }) {
  return (
    <div className={`hatch-planet ${className || ''}`} style={style} aria-hidden="true">
      <span className="hatch-planet__layer hatch-a mask-a" />
      <span className="hatch-planet__layer hatch-b mask-b" />
      <span className="hatch-planet__layer hatch-c mask-c" />
      <span className="hatch-planet__layer hatch-d mask-d" />
    </div>
  );
}

export default function Landing({ onNavigate, onConnectWallet, userPublicKey }) {
  const go = (event, view) => {
    event.preventDefault();
    onNavigate(view);
  };
  const short = `${CONTRACT_ID.slice(0, 4)}...${CONTRACT_ID.slice(-5)}`;

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="container landing-nav__inner">
          <a href="#" className="brand" onClick={(event) => go(event, 'home')}>
            <BrandMark />
            <span className="brand__word">STELLAR/TAGS</span>
          </a>
          <nav aria-label="Site" className="landing-nav__links">
            <a href="#how">How it works</a>
            <a href="#wallets">Wallets</a>
            <a href="#build">Developers</a>
            <a href="#help" onClick={(event) => go(event, 'help')}>
              Help
            </a>
          </nav>
          <div className="row-gap">
            <a href="#dashboard" className="btn btn--ghost" onClick={(event) => go(event, 'dashboard')}>
              Launch app
            </a>
            {!userPublicKey && (
              <button type="button" className="btn btn--primary hide-xs" onClick={onConnectWallet}>
                Connect wallet
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="ticker" aria-label="Network facts">
        <div className="ticker__track">
          {[...TICKER, ...TICKER].map((item, index) => (
            <span key={index} aria-hidden={index >= TICKER.length ? true : undefined}>
              {index % TICKER.length === 0 && <span className="dot dot--blue pulse" />}
              {item}
            </span>
          ))}
        </div>
      </div>

      <main id="main">
        <section className="container hero">
          <div className="hero__copy reveal">
            <p className="eyebrow eyebrow--blue">
              <span className="dot dot--blue pulse" aria-hidden="true" />
              Payments on Stellar, addressed by name
            </p>
            <h1 className="display">
              Pay a name.
              <span className="display__dim"> Not a 56-character key.</span>
            </h1>
            <p className="lede">
              Stellar Tags maps a handle like <span className="mono text-paper">you*{DEFAULT_FEDERATION_DOMAIN}</span> to
              your wallet. Claim it once, then send and receive XLM by name, routed through a Soroban
              contract.
            </p>
            <TagChecker onNavigate={onNavigate} />
          </div>
          <div className="hero__art">
            <div className="planet">
              <span className="planet__ring planet__ring--outer">
                <span className="planet__sat" />
              </span>
              <span className="planet__ring planet__ring--inner" />
              <DitherSphere className="planet__sphere" label="Dithered planet" />
              <span className="planet__scan" aria-hidden="true" />
              <div className="planet__chip mono">
                <span className="text-dim">RESOLVED</span>
                <span>aliphatic*{DEFAULT_FEDERATION_DOMAIN}</span>
                <span className="text-blue">to GAAF...LWST</span>
              </div>
            </div>
          </div>
        </section>

        <div className="dither-horizon" aria-hidden="true">
          <span className="dither-06" />
          <span className="dither-12" />
          <span className="dither-25" />
          <span className="dither-50" />
          <span className="dither-75" />
          <span className="paper-fill" />
        </div>

        <section id="how" className="paper-section">
          <div className="container section">
            <div className="section__head">
              <h2 className="h2">Three moves from wallet to name.</h2>
              <span className="mono text-ink-dim">/ 001 How it works</span>
            </div>
            <div className="steps">
              {STEPS.map((step) => (
                <article key={step.n} className="step lift">
                  <span className="mono">{step.n}</span>
                  <Icon name={step.icon} size={36} strokeWidth={1.75} className="text-blue" />
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="wallets" className="container section">
          <div className="section__head">
            <h2 className="h2">
              Every Stellar wallet.
              <span className="display__dim"> One button.</span>
            </h2>
            <span className="mono text-dim">/ 002 Wallets</span>
          </div>
          <div className="wallet-grid">
            {WALLETS.map((wallet) => (
              <button key={wallet.id} type="button" className="wallet-tile lift" onClick={onConnectWallet}>
                <span className="wallet-tile__mark dither-25" aria-hidden="true" />
                <span className="wallet-tile__name">{wallet.name}</span>
                <span className="mono text-muted">{wallet.kind}</span>
              </button>
            ))}
          </div>
        </section>

        <section id="build" className="build">
          <div className="container section build__inner">
            <div className="build__copy">
              <span className="mono text-dim">/ 003 Under the hood</span>
              <h2 className="h2">A ledger you can read.</h2>
              <p className="lede">
                Tags resolve through SEP-0002 federation. Payments route through the payment_router
                Soroban contract, with escrow, multisig and WebAuthn flows on the platform API.
              </p>
              <dl className="facts">
                <div>
                  <dt>~5s</dt>
                  <dd>ledger close</dd>
                </div>
                <div>
                  <dt>0.00001</dt>
                  <dd>XLM base fee</dd>
                </div>
                <div>
                  <dt>SEP-2</dt>
                  <dd>federation lookups</dd>
                </div>
                <div>
                  <dt className="text-blue">0</dt>
                  <dd>keys held by us</dd>
                </div>
              </dl>
            </div>
            <div className="terminal">
              <div className="terminal__bar mono">
                <span>resolve.sh</span>
                <span>testnet</span>
              </div>
              <pre className="terminal__body">
                <span className="text-muted">$ curl "{API_BASE}/federation?q=aliphatic*{DEFAULT_FEDERATION_DOMAIN}&amp;type=name"</span>
                {'\n'}
                <span>{'{ "account_id": "GAAF...6LWST" }'}</span>
                {'\n'}
                <span className="text-muted">
                  $ stellar contract invoke --id {short} -- route_payment --amount 250
                </span>
                {'\n'}
                <span className="text-blue">ok  ledger closed, fee 0.00001 XLM</span>
                {'\n'}
                <span className="text-muted">$ </span>
                <span className="cursor" aria-hidden="true" />
              </pre>
            </div>
          </div>
        </section>

        <section className="cta">
          <div className="cta__bands" aria-hidden="true">
            <span className="dither-blue-12" />
            <span className="dither-blue-25" />
            <span className="dither-blue-50" />
            <span className="blue-fill" />
          </div>
          <div className="container cta__inner">
            <h2 className="display display--ink">Your name is your address now.</h2>
            <a href="#register" className="btn btn--ink btn--lg" onClick={(event) => go(event, 'register')}>
              Claim your tag <Icon name="arrow" size={18} />
            </a>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container site-footer__top">
          <div className="site-footer__intro">
            <a href="#" className="brand brand--ink" onClick={(event) => go(event, 'home')}>
              <span className="brand__tile">
                <BrandMark ink="#FFFFFF" accent="#FFFFFF" />
              </span>
              <span className="brand__word">STELLAR/TAGS</span>
            </a>
            <p className="site-footer__tagline">
              Payments on Stellar, addressed by name. One tag, one ledger, nobody holding your keys but
              you.
            </p>
            <a
              className="btn btn--cobalt"
              href="https://github.com/ALIPHATICHYD/stellar-tags/releases"
              target="_blank"
              rel="noreferrer"
            >
              Follow releases on GitHub <Icon name="external" size={16} />
            </a>
          </div>
          <nav className="site-footer__cols" aria-label="Footer">
            <div>
              <h2>Product</h2>
              <a href="#dashboard" onClick={(event) => go(event, 'dashboard')}>Launch app</a>
              <a href="#register" onClick={(event) => go(event, 'register')}>Claim a tag</a>
              <a href="#wallets">Wallets</a>
              <a href="#analytics" onClick={(event) => go(event, 'analytics')}>Network pulse</a>
            </div>
            <div>
              <h2>Build</h2>
              <a href="#build">Federation API</a>
              <a href={`https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`} target="_blank" rel="noreferrer">
                Soroban router
              </a>
              <a href="https://github.com/ALIPHATICHYD/stellar-tags" target="_blank" rel="noreferrer">GitHub</a>
              <a href="https://developers.stellar.org/docs" target="_blank" rel="noreferrer">Stellar docs</a>
            </div>
            <div>
              <h2>Support</h2>
              <a href="#help" onClick={(event) => go(event, 'help')}>Help center</a>
              <a href="#help" onClick={(event) => go(event, 'help')}>Security</a>
              <a href="#history" onClick={(event) => go(event, 'history')}>History</a>
              <a href="https://github.com/ALIPHATICHYD/stellar-tags/issues" target="_blank" rel="noreferrer">Report an issue</a>
            </div>
          </nav>
        </div>
        <div className="site-footer__art" aria-hidden="true">
          <svg className="site-footer__orbit" viewBox="0 0 1440 520" preserveAspectRatio="xMidYMax slice">
            <ellipse cx="700" cy="300" rx="520" ry="120" transform="rotate(-12 700 300)" />
            <circle cx="1190" cy="190" r="6" />
          </svg>
          <HatchPlanet className="hp-1" />
          <div className="xlm-coin hp-2">
            <span className="hatch-b" />
            <span className="xlm-coin__ring" />
            <span className="xlm-coin__mark">*</span>
          </div>
          <HatchPlanet className="hp-3" />
          <HatchPlanet className="hp-4" />
          {[18, 24, 62, 78, 86, 55, 9, 94].map((left, index) => (
            <span key={left} className="speck" style={{ left: `${left}%`, top: `${20 + ((index * 37) % 50)}%`, animationDelay: `${index * 0.3}s` }} />
          ))}
        </div>
        <div className="container site-footer__base mono">
          <span>STELLAR/TAGS, AGPL-3.0</span>
          <span>{'{planet:stellar} {coin:xlm} {ledger:~5s}'}</span>
        </div>
      </footer>
    </div>
  );
}

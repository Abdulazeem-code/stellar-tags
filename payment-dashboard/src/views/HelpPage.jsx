import { useMemo, useState } from 'react';
import Icon from '../components/Icon';
import { DEFAULT_FEDERATION_DOMAIN } from './shared';

const TOPICS = [
  { id: 'all', label: 'All' },
  { id: 'tags', label: 'Tags' },
  { id: 'wallets', label: 'Wallets' },
  { id: 'payments', label: 'Payments' },
  { id: 'trouble', label: 'Troubleshooting' },
];

const FAQ = [
  {
    topic: 'tags',
    q: 'What is a tag?',
    a: `A short name like you*${DEFAULT_FEDERATION_DOMAIN} that points at your Stellar address. It is served over SEP-0002 federation, so any wallet that supports federation can resolve it.`,
  },
  {
    topic: 'tags',
    q: 'How do I claim one?',
    a: 'Open My tag, connect a wallet, pick a name of 3 to 20 letters or numbers and sign the message your wallet shows you. Signing proves you own the address. It costs nothing and sends no transaction.',
  },
  {
    topic: 'tags',
    q: 'Can I change my tag later?',
    a: 'Not yet. A tag is bound to one address once claimed, so choose one you are happy to share.',
  },
  {
    topic: 'wallets',
    q: 'Which wallets work?',
    a: 'Freighter, xBull, LOBSTR, Albedo, Rabet, Hana, HOT Wallet, Ledger and Trezor hardware wallets, and any wallet that speaks WalletConnect. Installed browser extensions show up under Detected in the connect window.',
  },
  {
    topic: 'wallets',
    q: 'Why does my wallet say it cannot sign the registration?',
    a: 'Claiming a tag needs a signed message. A few wallets, LOBSTR among them, cannot sign arbitrary messages yet. Claim your tag with Freighter, xBull, Albedo, Hana or Rabet, then use any wallet to send and receive.',
  },
  {
    topic: 'wallets',
    q: 'Do you hold my keys?',
    a: 'No. Stellar Tags only ever asks your wallet for your public key and for signatures you approve one by one.',
  },
  {
    topic: 'payments',
    q: 'How does a payment by name work?',
    a: 'The app resolves the tag to an address through federation, simulates a route_payment call on the Soroban payment_router contract, asks your wallet to sign it and submits it to the network. A ledger closes about every five seconds.',
  },
  {
    topic: 'payments',
    q: 'What does it cost?',
    a: 'The Stellar network fee, about 0.00001 XLM, plus the router fee of 0.4 percent capped at 30 XLM.',
  },
  {
    topic: 'trouble',
    q: 'The dashboard says simulation failed',
    a: 'The contract rejected the payment before it was signed. Usually the amount plus the router fee is more than your balance, or the recipient account does not exist on testnet yet.',
  },
  {
    topic: 'trouble',
    q: 'My account says it is not funded',
    a: 'New testnet accounts need XLM before they exist on the ledger. Use the Friendbot link on the dashboard to fund it with test XLM.',
  },
  {
    topic: 'trouble',
    q: 'The wallet window never opened',
    a: 'Check the extension icon in your browser. A locked wallet will not show a signing window until you unlock it. Pop-up blockers can also stop Albedo and WalletConnect.',
  },
];

function HelpPage({ onNavigate }) {
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState('all');
  const [open, setOpen] = useState(0);

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return FAQ.filter(
      (item) =>
        (topic === 'all' || item.topic === topic) &&
        (!needle || `${item.q} ${item.a}`.toLowerCase().includes(needle)),
    );
  }, [query, topic]);

  return (
    <div className="help">
      <section className="help__hero card">
        <div className="help__bands" aria-hidden="true">
          <span className="dither-blue-12" />
          <span className="dither-blue-25" />
        </div>
        <h2 className="h3">How can we help?</h2>
        <div className="field field--search field--lg" role="search">
          <Icon name="search" size={18} className="field__icon" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tags, wallets, payments"
            aria-label="Search the help center"
          />
        </div>
        <div className="segmented" role="group" aria-label="Topic">
          {TOPICS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={topic === item.id}
              onClick={() => {
                setTopic(item.id);
                setOpen(-1);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>

      <div className="help__body">
        <section className="faq" aria-label="Questions">
          {items.length === 0 && <p className="muted">No answers match that search.</p>}
          {items.map((item, index) => {
            const isOpen = open === index;
            return (
              <div key={item.q} className={`faq__item ${isOpen ? 'is-open' : ''}`}>
                <h3>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={`faq-${index}`}
                    onClick={() => setOpen(isOpen ? -1 : index)}
                  >
                    <span>{item.q}</span>
                    <Icon name={isOpen ? 'minus' : 'plus'} size={16} />
                  </button>
                </h3>
                {isOpen && (
                  <p id={`faq-${index}`} className="faq__answer">
                    {item.a}
                  </p>
                )}
              </div>
            );
          })}
        </section>

        <aside className="stack">
          <div className="card">
            <span className="eyebrow">Quick actions</span>
            <div className="link-list">
              <button type="button" onClick={() => onNavigate('register')}>
                <Icon name="tag" size={16} /> Claim a tag <Icon name="arrow" size={14} />
              </button>
              <button type="button" onClick={() => onNavigate('dashboard')}>
                <Icon name="send" size={16} /> Send a payment <Icon name="arrow" size={14} />
              </button>
              <button type="button" onClick={() => onNavigate('analytics')}>
                <Icon name="chart" size={16} /> Network status <Icon name="arrow" size={14} />
              </button>
            </div>
          </div>
          <div className="card">
            <span className="eyebrow">Still stuck?</span>
            <p className="muted">Open an issue with what you tried and the transaction hash if there is one.</p>
            <a
              className="btn btn--ghost btn--block"
              href="https://github.com/ALIPHATICHYD/stellar-tags/issues/new"
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="github" size={16} /> Report an issue
            </a>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default HelpPage;

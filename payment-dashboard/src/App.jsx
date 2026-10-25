import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast, Toaster } from 'react-hot-toast';
import logger from './logger';
import AppShell from './components/AppShell';
import ConnectWalletModal from './components/ConnectWalletModal';
import { HORIZON_BASE, API_BASE, errorMessage } from './views/shared';
import { connectedWalletId, disconnectWallet, walletName } from './lib/wallets';

const Landing = lazy(() => import('./views/Landing.jsx'));
const Dashboard = lazy(() => import('./views/Dashboard.jsx'));
const HelpPage = lazy(() => import('./views/HelpPage.jsx'));
const AnalyticsPage = lazy(() => import('./views/AnalyticsPage.jsx'));
const HistoryPage = lazy(() => import('./views/HistoryPage.jsx'));
const RegistrationPage = lazy(() => import('./views/RegistrationPage.jsx'));

const VIEWS = ['home', 'dashboard', 'register', 'history', 'analytics', 'help'];

const TITLES = {
  dashboard: { eyebrow: 'Wallet', title: 'Dashboard' },
  register: { eyebrow: 'Identity', title: 'Your tag' },
  history: { eyebrow: 'Ledger', title: 'Transaction history' },
  analytics: { eyebrow: 'Network, last 60 min', title: 'Insights and integrity' },
  help: { eyebrow: 'Support', title: 'Help center' },
};

const viewFromHash = () => {
  const hash = window.location.hash.replace('#', '');
  return VIEWS.includes(hash) ? hash : 'home';
};

function ViewFallback() {
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <span className="route-fallback__bar dither-25" aria-hidden="true" />
      <span className="mono">Loading</span>
    </div>
  );
}

function OfflineBanner() {
  return (
    <div className="offline-banner" role="alert">
      <span className="dot dot--danger" aria-hidden="true" />
      Offline. Network transactions will pause until your connection is back.
    </div>
  );
}

function App() {
  const [activeView, setActiveView] = useState(viewFromHash);
  const [userPublicKey, setUserPublicKey] = useState(
    () => localStorage.getItem('walletPublicKey') || '',
  );
  const [walletId, setWalletId] = useState(connectedWalletId);
  const [registrationState, setRegistrationState] = useState('unknown');
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [balance, setBalance] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [balanceError, setBalanceError] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);
  const connectResolver = useRef(null);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const syncView = () => setActiveView(viewFromHash());
    window.addEventListener('hashchange', syncView);
    return () => window.removeEventListener('hashchange', syncView);
  }, []);

  const handleNavigate = useCallback((view) => {
    setActiveView(view);
    const hash = view === 'home' ? '' : view;
    if (window.location.hash.replace('#', '') !== hash) {
      window.history.pushState(null, '', hash ? `#${hash}` : window.location.pathname);
    }
    window.scrollTo({ top: 0 });
  }, []);

  // Opens the wallet picker. Resolves with { ok, address } once the person
  // connects or closes the picker, so callers can await it.
  const handleConnectWallet = useCallback(
    () =>
      new Promise((resolve) => {
        connectResolver.current?.({ ok: false });
        connectResolver.current = resolve;
        setConnectOpen(true);
      }),
    [],
  );

  const closeConnect = useCallback(() => {
    setConnectOpen(false);
    connectResolver.current?.({ ok: false, error: 'Wallet connection cancelled.' });
    connectResolver.current = null;
  }, []);

  const handleConnected = useCallback(
    async (publicKey, id) => {
      localStorage.setItem('walletPublicKey', publicKey);
      setUserPublicKey(publicKey);
      setWalletId(id);
      setConnectOpen(false);
      connectResolver.current?.({ ok: true, address: publicKey });
      connectResolver.current = null;
      toast.success(`${walletName(id)} connected.`);

      try {
        const response = await fetch(`${API_BASE}/lookup?address=${encodeURIComponent(publicKey)}`);
        if (response.ok) {
          setRegistrationState('existing');
        } else if (response.status === 404) {
          setRegistrationState('new');
          handleNavigate('register');
          return;
        }
      } catch (error) {
        logger.error('Lookup after connect failed:', error);
      }
      setActiveView((view) => {
        if (view === 'home') {
          window.history.pushState(null, '', '#dashboard');
          return 'dashboard';
        }
        return view;
      });
    },
    [handleNavigate],
  );

  const handleDisconnectWallet = useCallback(async () => {
    await disconnectWallet();
    localStorage.removeItem('walletPublicKey');
    setUserPublicKey('');
    setWalletId('');
    setBalance(null);
    setRegistrationState('unknown');
    toast.success('Wallet disconnected.');
  }, []);

  const loadBalance = useCallback(async () => {
    if (!userPublicKey) return;
    setIsRefreshing(true);
    setBalanceError('');
    try {
      const response = await fetch(`${HORIZON_BASE}/accounts/${userPublicKey}`);
      if (response.status === 404) {
        throw new Error('This account is not funded on testnet yet.');
      }
      if (!response.ok) {
        throw new Error(`Horizon error (${response.status}).`);
      }
      const data = await response.json();
      const native = data?.balances?.find((item) => item.asset_type === 'native');
      setBalance(native?.balance ? Number(native.balance) : null);
    } catch (error) {
      setBalance(null);
      setBalanceError(errorMessage(error, 'Unable to load balance.'));
    } finally {
      setIsRefreshing(false);
    }
  }, [userPublicKey]);

  useEffect(() => {
    if (!userPublicKey) return;
    const run = async () => {
      await loadBalance();
    };
    run();
  }, [userPublicKey, loadBalance]);

  const handleRegistrationStateChange = useCallback((nextState) => {
    setRegistrationState(nextState);
  }, []);

  const shellProps = {
    active: activeView,
    onNavigate: handleNavigate,
    userPublicKey,
    walletId,
    onConnect: handleConnectWallet,
    onDisconnect: handleDisconnectWallet,
    ...TITLES[activeView],
  };

  let content;
  if (activeView === 'register') {
    content = (
      <RegistrationPage
        userPublicKey={userPublicKey}
        onConnectWallet={handleConnectWallet}
        registrationState={registrationState}
        onRegistered={() => setRegistrationState('existing')}
        onDone={() => handleNavigate('dashboard')}
      />
    );
  } else if (activeView === 'help') {
    content = <HelpPage onNavigate={handleNavigate} />;
  } else if (activeView === 'analytics') {
    content = <AnalyticsPage />;
  } else if (activeView === 'history') {
    content = (
      <HistoryPage
        userPublicKey={userPublicKey}
        onConnectWallet={handleConnectWallet}
        onRefreshBalance={loadBalance}
      />
    );
  } else {
    content = (
      <Dashboard
        userPublicKey={userPublicKey}
        onConnectWallet={handleConnectWallet}
        balance={balance}
        isRefreshing={isRefreshing}
        balanceError={balanceError}
        onRefreshBalance={loadBalance}
        onNavigate={handleNavigate}
        onRegistrationStateChange={handleRegistrationStateChange}
        registrationState={registrationState}
      />
    );
  }

  return (
    <>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 5000,
          className: 'toast',
          style: {
            background: '#111111',
            color: '#EDEBE4',
            border: '1px solid #3A3A3A',
            borderRadius: '0',
            padding: '12px 16px',
            fontSize: '14px',
            fontFamily: "'Geist', system-ui, sans-serif",
          },
          success: { iconTheme: { primary: '#4D8DFF', secondary: '#0A0A0A' } },
          error: { iconTheme: { primary: '#FF6B5E', secondary: '#0A0A0A' } },
        }}
      />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {isOffline && <OfflineBanner />}

      <Suspense fallback={<ViewFallback />}>
        {activeView === 'home' ? (
          <Landing
            onNavigate={handleNavigate}
            onConnectWallet={handleConnectWallet}
            userPublicKey={userPublicKey}
          />
        ) : (
          <AppShell {...shellProps}>
            <Suspense fallback={<ViewFallback />}>{content}</Suspense>
          </AppShell>
        )}
      </Suspense>

      {connectOpen && (
        <ConnectWalletModal onClose={closeConnect} onConnected={handleConnected} />
      )}
    </>
  );
}

export default App;

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { toast, Toaster } from "react-hot-toast";
import logger from "./logger";
import LoadingSpinner from './components/LoadingSpinner';
import { HORIZON_BASE, API_BASE, walletKit } from './views/shared';

const Dashboard = lazy(() => import('./views/Dashboard.jsx'));
const HelpPage = lazy(() => import('./views/HelpPage.jsx'));
const AnalyticsPage = lazy(() => import('./views/AnalyticsPage.jsx'));
const HistoryPage = lazy(() => import('./views/HistoryPage.jsx'));
const RegistrationPage = lazy(() => import('./views/RegistrationPage.jsx'));

function ViewFallback({ label = 'Loading view...' }) {
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <LoadingSpinner size="w-6 h-6" color="text-cyan" />
      <span>{label}</span>
    </div>
  );
}

function OfflineBanner() {
  return (
    <div className="offline-banner" role="alert">
      <span className="offline-dot" />
      <span>Offline Mode — Network transactions will pause until connection is restored.</span>
    </div>
  );
}

function App() {
  const [activeView, setActiveView] = useState('dashboard');
  const [userPublicKey, setUserPublicKey] = useState(() => {
    return localStorage.getItem('walletPublicKey') || '';
  });
  const [registrationState, setRegistrationState] = useState("unknown");
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [balance, setBalance] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [balanceError, setBalanceError] = useState("");

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const handleConnectWallet = async () => {
    try {
      await walletKit.openModal({
        onWalletSelected: async (option) => {
          try {
            walletKit.setWallet(option.id);
            const addressResponse = await walletKit.getAddress();
            
            const publicKey = typeof addressResponse === 'string' 
              ? addressResponse 
              : addressResponse.address;
            
            const dbResponse = await fetch(`${API_BASE}/lookup?address=${encodeURIComponent(publicKey)}`);
            
            if (dbResponse.ok) {
              setRegistrationState("existing");
            } else if (dbResponse.status === 404) {
              setRegistrationState("new");
              handleNavigate("register");
            }

            localStorage.setItem("walletPublicKey", publicKey);
            setUserPublicKey(publicKey);
            toast.success("Wallet connected successfully!");
          } catch (err) {
            logger.error("Wallet connection failed:", err);
            toast.error("Failed to connect wallet.");
          }
        },
      });

      return { ok: true };
    } catch (error) {
      toast.error("Connection cancelled.");
      logger.error("User closed modal or an error occurred:", error);
      return { ok: false, error: "Wallet connection process cancelled." };
    }
  };

  const handleDisconnectWallet = () => {
    localStorage.removeItem('walletPublicKey');
    setUserPublicKey('');
    setBalance(null);
    toast.success("Wallet disconnected.");
  };

  const loadBalance = useCallback(async () => {
    if (!userPublicKey) return;
    setIsRefreshing(true);
    setBalanceError("");
    try {
      const response = await fetch(`${HORIZON_BASE}/accounts/${userPublicKey}`);
      if (!response.ok) {
        throw new Error(`Horizon error (${response.status}).`);
      }

      const data = await response.json();
      const nativeBalance = data?.balances?.find(
        (item) => item.asset_type === "native",
      );
      const value = nativeBalance?.balance;
      setBalance(value ? Number(value) : null);
    } catch (error) {
      setBalance(null);
      setBalanceError(error.message || "Unable to load balance.");
    } finally {
      setIsRefreshing(false);
    }
  }, [userPublicKey]);

  useEffect(() => {
    if (!userPublicKey) {
      return;
    }
    const run = async () => {
      await loadBalance();
    };
    run();
  }, [userPublicKey, loadBalance]);

  useEffect(() => {
    const syncView = () => {
      const hash = window.location.hash;
      if (hash === "#register") {
        setActiveView("register");
        return;
      }
      if (hash === "#help") {
        setActiveView("help");
        return;
      }
      if (hash === "#analytics") {
        setActiveView("analytics");
        return;
      }
      if (hash === "#history") {
        setActiveView("history");
        return;
      }
      setActiveView("dashboard");
    };

    syncView();
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  const handleNavigate = useCallback((view) => {
    setActiveView(view);
    if (view === "register") {
      window.location.hash = "register";
    } else if (view === "help") {
      window.location.hash = "help";
    } else if (view === "analytics") {
      window.location.hash = "analytics";
    } else if (view === "history") {
      window.location.hash = "history";
    } else {
      window.location.hash = "";
    }
  }, []);

  const handleRegistrationStateChange = useCallback(
    (nextState) => {
      setRegistrationState(nextState);

      if (nextState === "new") {
        handleNavigate("register");
      }
      if (nextState === "existing" && activeView === "register") {
        handleNavigate("dashboard");
      }
    },
    [activeView, handleNavigate],
  );

  return (
    <>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 5000,
          style: {
            background: 'rgba(14, 20, 34, 0.94)',
            color: '#F8FAFC',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            backdropFilter: 'blur(20px)',
            boxShadow: '0 16px 40px rgba(0, 0, 0, 0.5)',
            borderRadius: '16px',
            padding: '14px 18px',
            fontSize: '14px',
            fontWeight: 600,
          },
          success: {
            iconTheme: {
              primary: '#10B981',
              secondary: '#050811',
            },
          },
          error: {
            iconTheme: {
              primary: '#F43F5E',
              secondary: '#050811',
            },
          },
        }}
      />
      {isOffline && <OfflineBanner />}

      {activeView === "register" && (registrationState === "new" || registrationState === "skipped") ? (
        <Suspense fallback={<ViewFallback label="Loading registration..." />}>
          <RegistrationPage
            userPublicKey={userPublicKey}
            setUserPublicKey={setUserPublicKey}
            onBack={() => {
              setRegistrationState("skipped");
              handleNavigate("dashboard");
            }}
            onRegistered={() => handleRegistrationStateChange("existing")}
          />
        </Suspense>
      ) : activeView === "help" ? (
        <Suspense fallback={<ViewFallback label="Loading help center..." />}>
          <HelpPage
            userPublicKey={userPublicKey}
            onConnectWallet={handleConnectWallet}
            onDisconnectWallet={handleDisconnectWallet}
            onDashboardClick={() => handleNavigate("dashboard")}
            onAnalyticsClick={() => handleNavigate("analytics")}
            onHistoryClick={() => handleNavigate("history")}
            onRegisterClick={() => handleNavigate("register")}
            canRegister={registrationState !== "existing"}
          />
        </Suspense>
      ) : activeView === "analytics" ? (
        <Suspense fallback={<ViewFallback label="Loading analytics..." />}>
          <AnalyticsPage
            userPublicKey={userPublicKey}
            onConnectWallet={handleConnectWallet}
            onDisconnectWallet={handleDisconnectWallet}
            onDashboardClick={() => handleNavigate("dashboard")}
            onHistoryClick={() => handleNavigate("history")}
            onHelpClick={() => handleNavigate("help")}
            onRegisterClick={() => handleNavigate("register")}
            canRegister={registrationState === "new"}
          />
        </Suspense>
      ) : activeView === "history" ? (
        <Suspense fallback={<ViewFallback label="Loading history..." />}>
          <HistoryPage
            userPublicKey={userPublicKey}
            setUserPublicKey={setUserPublicKey}
            onConnectWallet={handleConnectWallet}
            onDisconnectWallet={handleDisconnectWallet}
            onRefreshBalance={loadBalance}
            onDashboardClick={() => handleNavigate("dashboard")}
            onAnalyticsClick={() => handleNavigate("analytics")}
            onHelpClick={() => handleNavigate("help")}
            onRegisterClick={() => handleNavigate("register")}
            canRegister={registrationState === "new"}
          />
        </Suspense>
      ) : (
        <Suspense fallback={<ViewFallback label="Loading dashboard..." />}>
          <Dashboard
            userPublicKey={userPublicKey}
            onConnectWallet={handleConnectWallet}
            onDisconnectWallet={handleDisconnectWallet}
            balance={balance}
            isRefreshing={isRefreshing}
            balanceError={balanceError}
            onRefreshBalance={loadBalance}
            onRegisterClick={() => handleNavigate("register")}
            onAnalyticsClick={() => handleNavigate("analytics")}
            onHistoryClick={() => handleNavigate("history")}
            onHelpClick={() => handleNavigate("help")}
            onRegistrationStateChange={handleRegistrationStateChange}
            canRegister={registrationState === "new"}
          />
        </Suspense>
      )}
    </>
  );
}

export default App;

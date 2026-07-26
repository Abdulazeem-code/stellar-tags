import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import { Toaster } from 'react-hot-toast';
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
      <LoadingSpinner color="text-blue" />
      <span>{label}</span>
    </div>
  );
}

function App() {
const [activeView, setActiveView] = useState('dashboard')
  const [userPublicKey, setUserPublicKey] = useState(() => {
    return localStorage.getItem('walletPublicKey') || ''
  })
  const [registrationState, setRegistrationState] = useState("unknown");
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

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
            
            // Extract the key carefully to avoid the initialization error
            const publicKey = typeof addressResponse === 'string' 
              ? addressResponse 
              : addressResponse.address;
            
            // Now that publicKey is officially created, we can fetch the user
            const dbResponse = await fetch(`${API_BASE}/api/user/${publicKey}`);
            
            if (dbResponse.ok) {
              setRegistrationState("existing");
            } else if (dbResponse.status === 404) {
              setRegistrationState("new");
            }

            // Save the address to state so the UI updates
            localStorage.setItem("walletPublicKey", publicKey);
            setUserPublicKey(publicKey);
            
          } catch (err) {
            console.error("Wallet connection failed:", err);
          }
        },
      });

      return { ok: true };
    } catch (error) {
      console.error("User closed modal or an error occurred:", error);
      return { ok: false, error: "Wallet connection process cancelled." };
    }
  };

  const handleDisconnectWallet = () => {
    localStorage.removeItem('walletPublicKey')
    setUserPublicKey('')
    setBalance(null);
  };

  const [balance, setBalance] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [balanceError, setBalanceError] = useState("");

  const loadBalance = useCallback(async () => {
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
  }, [userPublicKey, setBalance, setIsRefreshing, setBalanceError]);

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
      return;
    }

    if (view === "help") {
      window.location.hash = "help";
      return;
    }

    if (view === "analytics") {
      window.location.hash = "analytics";
      return;
    }

    if (view === "history") {
      window.location.hash = "history";
      return;
    }

    window.location.hash = "";
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

  if (activeView === "register" && (registrationState === "new" || registrationState === "skipped")) {
    return (
      <>
        {isOffline && (
          <div
            style={{
              backgroundColor: "#DC2626",
              color: "#FFFFFF",
              padding: "12px 16px",
              textAlign: "center",
              fontWeight: "500",
              fontSize: "14px",
              position: "sticky",
              top: 0,
              zIndex: 1000,
            }}
          >
            ⚠️ You are currently offline. Transactions will fail.
          </div>
        )}
        <Suspense fallback={<ViewFallback label="Loading registration..." />}>

        <RegistrationPage
          userPublicKey={userPublicKey}
          setUserPublicKey={setUserPublicKey}
          onBack={() => {
            setRegistrationState("skipped"); // This breaks the loop!
            handleNavigate("dashboard");
          }}
          onRegistered={() => handleRegistrationStateChange("existing")}
        />
        </Suspense>
      </>
    );
  }

  if (activeView === "help") {
    return (
      <>
        {isOffline && (
          <div
            style={{
              backgroundColor: "#DC2626",
              color: "#FFFFFF",
              padding: "12px 16px",
              textAlign: "center",
              fontWeight: "500",
              fontSize: "14px",
              position: "sticky",
              top: 0,
              zIndex: 1000,
            }}
          >
            ⚠️ You are currently offline. Transactions will fail.
          </div>
        )}
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
      </>
    );
  }

  if (activeView === "analytics") {
    return (
      <>
        {isOffline && (
          <div
            style={{
              backgroundColor: "#DC2626",
              color: "#FFFFFF",
              padding: "12px 16px",
              textAlign: "center",
              fontWeight: "500",
              fontSize: "14px",
              position: "sticky",
              top: 0,
              zIndex: 1000,
            }}
          >
            ⚠️ You are currently offline. Transactions will fail.
          </div>
        )}
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
      </>
    );
  }

  if (activeView === "history") {
    return (
      <>
        {isOffline && (
          <div
            style={{
              backgroundColor: "#DC2626",
              color: "#FFFFFF",
              padding: "12px 16px",
              textAlign: "center",
              fontWeight: "500",
              fontSize: "14px",
              position: "sticky",
              top: 0,
              zIndex: 1000,
            }}
          >
            ⚠️ You are currently offline. Transactions will fail.
          </div>
        )}
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
      </>
    );
  }

  return (
    <>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 5000,
          style: { borderRadius: '12px', padding: '14px 18px', fontSize: '14px', fontWeight: 500 },
        }}
      />
      {isOffline && (
        <div
          style={{
            backgroundColor: "#DC2626",
            color: "#FFFFFF",
            padding: "12px 16px",
            textAlign: "center",
            fontWeight: "500",
            fontSize: "14px",
            position: "sticky",
            top: 0,
            zIndex: 1000,
          }}
        >
          ⚠️ You are currently offline. Transactions will fail.
        </div>
      )}
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
    </>
  );
}

export default App;

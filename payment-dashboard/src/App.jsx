import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import freighterApi from '@stellar/freighter-api'
import * as StellarSdk from 'stellar-sdk'

const CONTRACT_ID = 'CB5FYOCWBQA2PI3DQDFOTW5BSIVIMHBOVBBNXRBOASRFWWPRVRTVFXA2'
const TREASURY_ADDRESS = 'GAAFWEZKDYPXLTQGKQ3F23TXWYQUDAYTDW7P7VUQSVJFW2GWC4Y6LWST'
const TOKEN_ADDRESS = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const API_BASE = import.meta.env.VITE_API_BASE ?? ''
const DEFAULT_FEDERATION_DOMAIN = 'localhost'
const HORIZON_BASE = 'https://horizon-testnet.stellar.org'

const normalizeNameTag = (value) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  return trimmed.includes('*') ? trimmed : `${trimmed}*${DEFAULT_FEDERATION_DOMAIN}`
}

const resolveRecipient = async (inputValue) => {
  const trimmed = inputValue.trim()
  if (!trimmed) {
    return { error: 'Please enter a username or wallet address.' }
  }

  if (StellarSdk.StrKey.isValidEd25519PublicKey(trimmed)) {
    return { address: trimmed }
  }

  const normalizedTag = normalizeNameTag(trimmed)
  return { tag: normalizedTag }
}

const formatUsername = (value) => {
  if (!value) {
    return ''
  }

  return value.split('*')[0]
}

const formatShortAddress = (value) => {
  if (!value) {
    return ''
  }

  if (value.length < 10) {
    return value
  }

  return `${value.substring(0, 4)}...${value.substring(52)}`
}

const NAV_STORAGE_KEY = 'stellar-nav-open'

const useNavState = () => {
  const [isNavOpen, setIsNavOpen] = useState(() => {
    const stored = sessionStorage.getItem(NAV_STORAGE_KEY)
    if (stored === 'true' || stored === 'false') {
      return stored === 'true'
    }

    return window.matchMedia('(min-width: 769px)').matches
  })

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const syncNav = (event) => {
      if (event.matches) {
        setIsNavOpen(false)
      }
    }

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', syncNav)
      return () => mediaQuery.removeEventListener('change', syncNav)
    }

    mediaQuery.addListener(syncNav)
    return () => mediaQuery.removeListener(syncNav)
  }, [])

  useEffect(() => {
    sessionStorage.setItem(NAV_STORAGE_KEY, String(isNavOpen))
  }, [isNavOpen])

  return [isNavOpen, setIsNavOpen]
}

const useWalletMenu = () => {
  const menuRef = useRef(null)
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return { menuRef, isOpen, setIsOpen }
}

function App() {
  const [activeView, setActiveView] = useState('dashboard')
  const [userPublicKey, setUserPublicKey] = useState('')
  const [registrationState, setRegistrationState] = useState('unknown')

  const handleConnectWallet = async () => {
    const status = await freighterApi.isConnected()
    const isInstalled = status.isConnected !== undefined ? status.isConnected : status

    if (!isInstalled) {
      return { ok: false, error: 'Freighter is not installed or locked.' }
    }

    const response = await freighterApi.requestAccess()
    if (response.error) {
      return { ok: false, error: 'Wallet connection failed.' }
    }

    setUserPublicKey(response.address)
    return { ok: true, address: response.address }
  }

  const handleDisconnectWallet = () => {
    setUserPublicKey('')
  }

  const [balance, setBalance] = useState(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [balanceError, setBalanceError] = useState('')

  const loadBalance = async () => {
    if (!userPublicKey) {
      setBalance(null)
      setBalanceError('')
      return
    }

    setIsRefreshing(true)
    setBalanceError('')
    try {
      const response = await fetch(`${HORIZON_BASE}/accounts/${userPublicKey}`)
      if (!response.ok) {
        throw new Error(`Horizon error (${response.status}).`)
      }

      const data = await response.json()
      const nativeBalance = data?.balances?.find((item) => item.asset_type === 'native')
      const value = nativeBalance?.balance
      setBalance(value ? Number(value) : null)
    } catch (error) {
      setBalance(null)
      setBalanceError(error.message || 'Unable to load balance.')
    } finally {
      setIsRefreshing(false)
    }
  }

  useEffect(() => {
    loadBalance()
  }, [userPublicKey])

  useEffect(() => {
    const syncView = () => {
      const hash = window.location.hash
      if (hash === '#register') {
        setActiveView('register')
        return
      }

      if (hash === '#help') {
        setActiveView('help')
        return
      }

      if (hash === '#analytics') {
        setActiveView('analytics')
        return
      }

      if (hash === '#history') {
        setActiveView('history')
        return
      }

      setActiveView('dashboard')
    }

    syncView()
    window.addEventListener('hashchange', syncView)
    return () => window.removeEventListener('hashchange', syncView)
  }, [])

  const handleNavigate = (view) => {
    setActiveView(view)
    if (view === 'register') {
      window.location.hash = 'register'
      return
    }

    if (view === 'help') {
      window.location.hash = 'help'
      return
    }

    if (view === 'analytics') {
      window.location.hash = 'analytics'
      return
    }

    if (view === 'history') {
      window.location.hash = 'history'
      return
    }

    window.location.hash = ''
  }

  const handleRegistrationStateChange = (nextState) => {
    setRegistrationState(nextState)

    if (nextState === 'new') {
      handleNavigate('register')
    }

    if (nextState === 'existing' && activeView === 'register') {
      handleNavigate('dashboard')
    }
  }

  if (activeView === 'register' && registrationState === 'new') {
    return (
      <RegistrationPage
        userPublicKey={userPublicKey}
        setUserPublicKey={setUserPublicKey}
        onBack={() => handleNavigate('dashboard')}
        onRegistered={() => handleRegistrationStateChange('existing')}
      />
    )
  }

  if (activeView === 'help') {
    return (
      <HelpPage
        userPublicKey={userPublicKey}
        onConnectWallet={handleConnectWallet}
        onDisconnectWallet={handleDisconnectWallet}
        onDashboardClick={() => handleNavigate('dashboard')}
        onAnalyticsClick={() => handleNavigate('analytics')}
        onHistoryClick={() => handleNavigate('history')}
        onRegisterClick={() => handleNavigate('register')}
        canRegister={registrationState === 'new'}
      />
    )
  }

  if (activeView === 'analytics') {
    return (
      <AnalyticsPage
        userPublicKey={userPublicKey}
        onConnectWallet={handleConnectWallet}
        onDisconnectWallet={handleDisconnectWallet}
        onDashboardClick={() => handleNavigate('dashboard')}
        onHistoryClick={() => handleNavigate('history')}
        onHelpClick={() => handleNavigate('help')}
        onRegisterClick={() => handleNavigate('register')}
        canRegister={registrationState === 'new'}
      />
    )
  }

  if (activeView === 'history') {
    return (
      <HistoryPage
        userPublicKey={userPublicKey}
        setUserPublicKey={setUserPublicKey}
        onConnectWallet={handleConnectWallet}
        onDisconnectWallet={handleDisconnectWallet}
        onRefreshBalance={loadBalance}
        onDashboardClick={() => handleNavigate('dashboard')}
        onAnalyticsClick={() => handleNavigate('analytics')}
        onHelpClick={() => handleNavigate('help')}
        onRegisterClick={() => handleNavigate('register')}
        canRegister={registrationState === 'new'}
      />
    )
  }

  return (
    <Dashboard
      userPublicKey={userPublicKey}
      setUserPublicKey={setUserPublicKey}
      onConnectWallet={handleConnectWallet}
      onDisconnectWallet={handleDisconnectWallet}
      balance={balance}
      isRefreshing={isRefreshing}
      balanceError={balanceError}
      onRefreshBalance={loadBalance}
      onRegisterClick={() => handleNavigate('register')}
      onAnalyticsClick={() => handleNavigate('analytics')}
      onHistoryClick={() => handleNavigate('history')}
      onHelpClick={() => handleNavigate('help')}
      onRegistrationStateChange={handleRegistrationStateChange}
      canRegister={registrationState === 'new'}
    />
  )
}

function Dashboard({
  userPublicKey,
  setUserPublicKey,
  onConnectWallet,
  onDisconnectWallet,
  balance,
  isRefreshing,
  balanceError,
  onRefreshBalance,
  onRegisterClick,
  onAnalyticsClick,
  onHistoryClick,
  onHelpClick,
  onRegistrationStateChange,
  canRegister,
}) {
  const [isNavOpen, setIsNavOpen] = useNavState()
  const { menuRef, isOpen: isWalletMenuOpen, setIsOpen: setIsWalletMenuOpen } = useWalletMenu()
  const closeNav = () => {
    sessionStorage.setItem(NAV_STORAGE_KEY, 'false')
    setIsNavOpen(false)
  }
  const handleNav = (action) => {
    sessionStorage.setItem(NAV_STORAGE_KEY, 'false')
    setIsNavOpen(false)
    action()
  }
  const [nameTag, setNameTag] = useState('')
  const [amount, setAmount] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [isReceiving, setIsReceiving] = useState(false)
  const [activeBalancePanel, setActiveBalancePanel] = useState('')
  const [receiveAddress, setReceiveAddress] = useState('')
  const [receiveTag, setReceiveTag] = useState('')
  const [receiveStatus, setReceiveStatus] = useState({
    text: '',
    color: '#1F2937',
    bgColor: '#F3F4F6',
  })
  const [status, setStatus] = useState({
    text: '',
    color: '#1F2937',
    bgColor: '#F3F4F6',
  })

  const walletLabel = userPublicKey
    ? `Connected: ${userPublicKey.substring(0, 5)}...${userPublicKey.substring(51)}`
    : ''

  const displayMessage = (text, color, bgColor) => {
    setStatus({ text, color, bgColor })
  }

  const displayReceiveMessage = (text, color, bgColor) => {
    setReceiveStatus({ text, color, bgColor })
  }

  useEffect(() => {
    if (!userPublicKey) {
      setReceiveAddress('')
      setReceiveTag('')
      displayReceiveMessage('Connect your wallet to reveal your receive details.', '#1F2937', '#F3F4F6')
      onRegistrationStateChange('unknown')
      return
    }

    const loadReceiveDetails = async () => {
      setIsReceiving(true)
      displayReceiveMessage('Loading your receive details...', '#1F2937', '#F3F4F6')

      try {
        const response = await fetch(`${API_BASE}/lookup?address=${encodeURIComponent(userPublicKey)}`)
        const rawBody = await response.text()
        const data = rawBody ? JSON.parse(rawBody) : null

        if (response.ok && data) {
          setReceiveAddress(data.address)
          setReceiveTag(data.username)
          displayReceiveMessage('Share your username or wallet address.', '#059669', '#D1FAE5')
          onRegistrationStateChange('existing')
          return
        }

        if (response.status === 404) {
          setReceiveAddress(userPublicKey)
          setReceiveTag('')
          displayReceiveMessage('No username found. Register to claim one.', '#D97706', '#FEF3C7')
          onRegistrationStateChange('new')
          return
        }

        throw new Error((data && data.detail) || `Backend error (${response.status}).`)
      } catch (error) {
        setReceiveAddress(userPublicKey)
        setReceiveTag('')
        displayReceiveMessage(error.message || 'Unable to load receive details.', '#DC2626', '#FEE2E2')
        onRegistrationStateChange('unknown')
      } finally {
        setIsReceiving(false)
      }
    }

    loadReceiveDetails()
  }, [userPublicKey])

  const handleConnect = async () => {
    const result = await onConnectWallet()
    if (!result.ok) {
      displayMessage(result.error || 'Wallet connection failed.', '#DC2626', '#FEE2E2')
      return
    }

    displayMessage('Wallet connected.', '#059669', '#D1FAE5')
  }

  const handleLookup = async () => {
    const recipientInput = nameTag.trim()
    const amountValue = parseFloat(amount)

    if (!amountValue || Number.isNaN(amountValue) || amountValue <= 0) {
      displayMessage('Please enter a valid amount greater than zero.', '#DC2626', '#FEE2E2')
      return
    }

    setIsProcessing(true)
    displayMessage('Verifying recipient...', '#1F2937', '#F3F4F6')

    try {
      const resolved = await resolveRecipient(recipientInput)
      if (resolved.error) {
        throw new Error(resolved.error)
      }

      let recipientAddress = resolved.address

      if (!recipientAddress && resolved.tag) {
        const encodedTag = encodeURIComponent(resolved.tag)
        const response = await fetch(`${API_BASE}/federation?q=${encodedTag}&type=name`)
        const rawBody = await response.text()
        const data = rawBody ? JSON.parse(rawBody) : null

        if (!response.ok) {
          throw new Error((data && data.detail) || `Backend error (${response.status}).`)
        }

        if (!data) {
          throw new Error('Backend returned an empty response.')
        }

        recipientAddress = data.account_id
      }

      if (!recipientAddress) {
        throw new Error('Recipient address could not be resolved.')
      }
      displayMessage('Simulating smart contract execution...', '#1F2937', '#F3F4F6')

      const contractArgs = [
        StellarSdk.nativeToScVal(userPublicKey, { type: 'address' }),
        StellarSdk.nativeToScVal(recipientAddress, { type: 'address' }),
        StellarSdk.nativeToScVal(TREASURY_ADDRESS, { type: 'address' }),
        StellarSdk.nativeToScVal(TOKEN_ADDRESS, { type: 'address' }),
        StellarSdk.nativeToScVal(Math.floor(amountValue * 10000000), { type: 'i128' }),
        StellarSdk.nativeToScVal(2, { type: 'i128' }),
      ]

      const server = new StellarSdk.rpc.Server('https://soroban-testnet.stellar.org')
      const account = await server.getAccount(userPublicKey)

      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: '100000',
        networkPassphrase: 'Test SDF Network ; September 2015',
      })
        .addOperation(
          StellarSdk.Operation.invokeHostFunction({
            func: new StellarSdk.xdr.HostFunction.hostFunctionTypeInvokeContract(
              new StellarSdk.xdr.InvokeContractArgs({
                contractAddress: StellarSdk.Address.fromString(CONTRACT_ID).toScAddress(),
                functionName: 'route_payment',
                args: contractArgs,
              }),
            ),
            auth: [],
          }),
        )
        .setTimeout(300)
        .build()

      const preparedTransaction = await server.prepareTransaction(transaction)
      if (preparedTransaction.error) {
        throw new Error('Contract simulation failed. Check wallet funds.')
      }

      displayMessage('Please approve the transaction in your wallet.', '#0052FF', '#EFF6FF')
      const signedXdr = await freighterApi.signTransaction(preparedTransaction.toXDR(), {
        network: 'TESTNET',
        networkPassphrase: 'Test SDF Network ; September 2015',
      })

      if (signedXdr.error) {
        throw new Error('Transaction canceled by user.')
      }

      displayMessage('Submitting to Stellar Testnet...', '#D97706', '#FEF3C7')

      const finalXdr = signedXdr.signedTxXdr || signedXdr
      const freighterTx = StellarSdk.TransactionBuilder.fromXDR(
        finalXdr,
        'Test SDF Network ; September 2015',
      )
      preparedTransaction.signatures.length = 0
      freighterTx.signatures.forEach((sig) => preparedTransaction.signatures.push(sig))

      const result = await server.sendTransaction(preparedTransaction)
      if (result.status === 'PENDING' || result.status === 'SUCCESS') {
        displayMessage('Payment successful!', '#059669', '#D1FAE5')
        setAmount('')
        onRefreshBalance()
        window.dispatchEvent(new Event('stellar:tx-update'))
      } else {
        throw new Error(`Blockchain rejected transaction: ${result.status}`)
      }
    } catch (error) {
      displayMessage(error.message || 'A network error occurred.', '#DC2626', '#FEE2E2')
    } finally {
      setIsProcessing(false)
    }
  }


  const handleCopy = async (value, label) => {
    if (!value) {
      return
    }

    try {
      await navigator.clipboard.writeText(value)
      displayReceiveMessage(`${label} copied to clipboard.`, '#059669', '#D1FAE5')
    } catch (error) {
      displayReceiveMessage('Copy failed. Please copy manually.', '#DC2626', '#FEE2E2')
    }
  }

  const handleDisconnect = () => {
    setIsWalletMenuOpen(false)
    onDisconnectWallet()
    displayMessage('Wallet disconnected.', '#1F2937', '#F3F4F6')
  }

  return (
    <div className={`dashboard ${isNavOpen ? 'nav-open' : ''}`}>
      <button
        type="button"
        className={`sidebar-scrim ${isNavOpen ? 'is-open' : ''}`}
        onClick={() => setIsNavOpen(false)}
        aria-label="Close navigation"
      />
      <aside className={`sidebar ${isNavOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">S</div>
          <h1>Stellar Pay</h1>
        </div>
        <div className="nav">
          <button type="button" onClick={closeNav}>Dashboard</button>
          <button type="button" onClick={() => handleNav(onHistoryClick)}>History</button>
          <button type="button" onClick={() => handleNav(onAnalyticsClick)}>Analytics</button>
          <button type="button" onClick={() => handleNav(onHelpClick)}>Help</button>
          {canRegister && (
            <button type="button" onClick={() => handleNav(onRegisterClick)}>Registration</button>
          )}
        </div>
        <div className="sidebar-card">
          <h3>Network pulse</h3>
          <p>Testnet status is healthy. Avg confirmation 3.9s.</p>
        </div>
        <div className="sidebar-card">
          <h3>Support</h3>
          <p>Need a hand? Open the help panel for quick answers.</p>
        </div>
        {userPublicKey && (
          <button type="button" className="disconnect-button" onClick={handleDisconnect}>
            Disconnect wallet
          </button>
        )}
      </aside>

      <main className="main">
        <section className="topbar reveal">
          <button
            type="button"
            className="hamburger"
            onClick={() => setIsNavOpen((prev) => !prev)}
            aria-label="Toggle navigation"
            aria-expanded={isNavOpen}
          >
            <span />
            <span />
            <span />
          </button>
          <div>
            <h2 className="headline">Payments, designed for stellar speed.</h2>
            <p className="subtle">
              Realtime routing, verified name tags, and a clear view of activity.
            </p>
          </div>
          <div className="topbar-actions">
            <span className="chip">Today: May 4</span>
            <span className="chip">Testnet</span>
            <div className="wallet-menu" ref={menuRef}>
              <button
                type="button"
                className="connect-pill"
                onClick={() => {
                  if (userPublicKey) {
                    setIsWalletMenuOpen((prev) => !prev)
                  } else {
                    handleConnect()
                  }
                }}
                aria-expanded={isWalletMenuOpen}
              >
                {userPublicKey
                  ? `Connected: ${formatShortAddress(userPublicKey)}`
                  : 'Connect wallet'}
              </button>
              {userPublicKey && isWalletMenuOpen && (
                <div className="wallet-dropdown">
                  <button type="button" onClick={handleDisconnect}>
                    Disconnect wallet
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="grid columns-1 balance-grid">
          <div className="card reveal balance-card">
            <div className="card-header">
              <h2>Current balance</h2>
              <button
                type="button"
                className={`refresh-button ${isRefreshing ? 'is-loading' : ''}`}
                onClick={onRefreshBalance}
                disabled={!userPublicKey || isRefreshing}
                aria-label="Refresh balance"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20 12a8 8 0 1 1-2.34-5.66" />
                  <path d="M20 4v6h-6" />
                </svg>
              </button>
            </div>
            {balanceError && <div className="balance-error">{balanceError}</div>}
            <div className="metric">
              {balance !== null ? balance.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }) : '--'}{' '}
              <span>XLM</span>
            </div>
            <div className="spark"></div>
            <div className="balance-tabs">
              <button
                type="button"
                className={activeBalancePanel === 'transfer' ? 'is-active' : ''}
                onClick={() => setActiveBalancePanel('transfer')}
              >
                Transfer
              </button>
              <button
                type="button"
                className={activeBalancePanel === 'receive' ? 'is-active' : ''}
                onClick={() => setActiveBalancePanel('receive')}
              >
                Receive
              </button>
            </div>
            {activeBalancePanel === 'transfer' && (
              <div className="balance-panel">
                {!userPublicKey && (
                  <div className="wallet-status">Connect your wallet to make a transfer.</div>
                )}
                {walletLabel && <div className="wallet-status">{walletLabel}</div>}
                <label>Recipient username or address</label>
                <input
                  type="text"
                  value={nameTag}
                  onChange={(event) => setNameTag(event.target.value)}
                  placeholder="e.g., walzeem or G..."
                  autoComplete="off"
                  disabled={!userPublicKey || isProcessing}
                />

                <label>Amount (XLM)</label>
                <input
                  type="number"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                  min="0.01"
                  step="0.01"
                  disabled={!userPublicKey || isProcessing}
                />

                <button
                  type="button"
                  className="accent-btn"
                  onClick={handleLookup}
                  disabled={!userPublicKey || isProcessing}
                >
                  {isProcessing ? 'Processing...' : 'Transfer'}
                </button>
              </div>
            )}
            {activeBalancePanel === 'receive' && (
              <div className="balance-panel">
                {!userPublicKey && (
                  <div className="wallet-status">Connect your wallet to view receive details.</div>
                )}
                {userPublicKey && receiveAddress && (
                  <div className="receive-panel">
                    {receiveTag && (
                      <div className="wallet-status">
                        Username: {formatUsername(receiveTag)}
                      </div>
                    )}
                    <div className="wallet-status">
                      Address: {receiveAddress}
                    </div>
                    <div className="inline-actions">
                      {receiveTag && (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => handleCopy(formatUsername(receiveTag), 'Username')}
                          disabled={isReceiving}
                        >
                          Copy username
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => handleCopy(receiveAddress, 'Address')}
                        disabled={isReceiving}
                      >
                        Copy address
                      </button>
                    </div>
                    <div className="qr-card">
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(receiveAddress)}`}
                        alt="Wallet address QR code"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
            {status.text && (
              <div
                id="status-box"
                style={{ color: status.color, backgroundColor: status.bgColor }}
              >
                {status.text}
              </div>
            )}
          </div>
        </section>

      </main>
      <MobileNav
        active="dashboard"
        onDashboardClick={closeNav}
        onHistoryClick={() => handleNav(onHistoryClick)}
        onAnalyticsClick={() => handleNav(onAnalyticsClick)}
        onHelpClick={() => handleNav(onHelpClick)}
        onRegisterClick={() => handleNav(onRegisterClick)}
        canRegister={canRegister}
      />
    </div>
  )
}

function HelpPage({
  userPublicKey,
  onConnectWallet,
  onDisconnectWallet,
  onDashboardClick,
  onAnalyticsClick,
  onHistoryClick,
  onRegisterClick,
  canRegister,
}) {
  const [isNavOpen, setIsNavOpen] = useNavState()
  const [isConnecting, setIsConnecting] = useState(false)
  const { menuRef, isOpen: isWalletMenuOpen, setIsOpen: setIsWalletMenuOpen } = useWalletMenu()
  const closeNav = () => {
    sessionStorage.setItem(NAV_STORAGE_KEY, 'false')
    setIsNavOpen(false)
  }
  const handleNav = (action) => {
    sessionStorage.setItem(NAV_STORAGE_KEY, 'false')
    setIsNavOpen(false)
    action()
  }

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      await onConnectWallet()
    } finally {
      setIsConnecting(false)
    }
  }
  return (
    <div className={`dashboard ${isNavOpen ? 'nav-open' : ''}`}>
      <button
        type="button"
        className={`sidebar-scrim ${isNavOpen ? 'is-open' : ''}`}
        onClick={() => setIsNavOpen(false)}
        aria-label="Close navigation"
      />
      <aside className={`sidebar ${isNavOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">S</div>
          <h1>Stellar Pay</h1>
        </div>
        <div className="nav">
          <button type="button" onClick={() => handleNav(onDashboardClick)}>Dashboard</button>
          <button type="button" onClick={() => handleNav(onHistoryClick)}>History</button>
          <button type="button" onClick={() => handleNav(onAnalyticsClick)}>Analytics</button>
          <button type="button" aria-current="page" onClick={closeNav}>Help</button>
          {canRegister && (
            <button type="button" onClick={() => handleNav(onRegisterClick)}>Registration</button>
          )}
        </div>
        <div className="sidebar-card">
          <h3>Support hours</h3>
          <p>Live help is active Mon-Fri, 09:00-18:00 UTC.</p>
        </div>
        <div className="sidebar-card">
          <h3>Contact</h3>
          <p>Need a real person? Open a ticket from your wallet settings.</p>
        </div>
        {userPublicKey && (
          <button type="button" className="disconnect-button" onClick={onDisconnectWallet}>
            Disconnect wallet
          </button>
        )}
      </aside>

      <main className="main">
        <section className="topbar reveal">
          <button
            type="button"
            className="hamburger"
            onClick={() => setIsNavOpen((prev) => !prev)}
            aria-label="Toggle navigation"
            aria-expanded={isNavOpen}
          >
            <span />
            <span />
            <span />
          </button>
          <div>
            <h2 className="headline">Help center</h2>
            <p className="subtle">Get answers fast, or reach the support team.</p>
          </div>
          <div className="topbar-actions">
            <span className="chip">Updated May 5</span>
            <span className="chip">Testnet</span>
            <div className="wallet-menu" ref={menuRef}>
              <button
                type="button"
                className="connect-pill"
                onClick={() => {
                  if (userPublicKey) {
                    setIsWalletMenuOpen((prev) => !prev)
                  } else {
                    handleConnect()
                  }
                }}
                disabled={isConnecting}
                aria-expanded={isWalletMenuOpen}
              >
                {userPublicKey
                  ? `Connected: ${formatShortAddress(userPublicKey)}`
                  : isConnecting
                    ? 'Connecting...'
                    : 'Connect wallet'}
              </button>
              {userPublicKey && isWalletMenuOpen && (
                <div className="wallet-dropdown">
                  <button type="button" onClick={onDisconnectWallet}>
                    Disconnect wallet
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="card reveal">
          <div className="card-header">
            <h2>Quick answers</h2>
            <span className="chip">Live docs</span>
          </div>
          <div className="help-panel">
            <div>
              <strong>Verify a name tag</strong> - Use the format name*domain, then confirm the
              domain is trusted.
            </div>
            <div><strong>Fees</strong> - Routing fee is applied to treasury per transaction.</div>
            <div><strong>Wallet tips</strong> - Keep Freighter unlocked to sign without delays.</div>
          </div>
        </section>

        <section className="grid columns-2">
          <div className="card reveal">
            <div className="card-header">
              <h2>Getting started</h2>
              <span className="chip">3 steps</span>
            </div>
            <div className="stack">
              <div>1. Connect Freighter and confirm your public key.</div>
              <div>2. Register a username to share with senders.</div>
              <div>3. Use the send card to route payments instantly.</div>
            </div>
          </div>
          <div className="card reveal">
            <div className="card-header">
              <h2>Support channels</h2>
              <span className="chip">Always on</span>
            </div>
            <div className="stack">
              <div>Search the docs or open a ticket from your account.</div>
              <div>Join the Stellar community for peer support.</div>
              <div>Report incidents through the security intake form.</div>
            </div>
          </div>
        </section>
      </main>
      <MobileNav
        active="help"
        onDashboardClick={() => handleNav(onDashboardClick)}
        onHistoryClick={() => handleNav(onHistoryClick)}
        onAnalyticsClick={() => handleNav(onAnalyticsClick)}
        onHelpClick={closeNav}
        onRegisterClick={() => handleNav(onRegisterClick)}
        canRegister={canRegister}
      />
    </div>
  )
}

function AnalyticsPage({
  userPublicKey,
  onConnectWallet,
  onDisconnectWallet,
  onDashboardClick,
  onHistoryClick,
  onHelpClick,
  onRegisterClick,
  canRegister,
}) {
  const [isNavOpen, setIsNavOpen] = useNavState()
  const [isConnecting, setIsConnecting] = useState(false)
  const { menuRef, isOpen: isWalletMenuOpen, setIsOpen: setIsWalletMenuOpen } = useWalletMenu()
  const closeNav = () => {
    sessionStorage.setItem(NAV_STORAGE_KEY, 'false')
    setIsNavOpen(false)
  }
  const handleNav = (action) => {
    sessionStorage.setItem(NAV_STORAGE_KEY, 'false')
    setIsNavOpen(false)
    action()
  }

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      await onConnectWallet()
    } finally {
      setIsConnecting(false)
    }
  }
  return (
    <div className={`dashboard ${isNavOpen ? 'nav-open' : ''}`}>
      <button
        type="button"
        className={`sidebar-scrim ${isNavOpen ? 'is-open' : ''}`}
        onClick={() => setIsNavOpen(false)}
        aria-label="Close navigation"
      />
      <aside className={`sidebar ${isNavOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">S</div>
          <h1>Stellar Pay</h1>
        </div>
        <div className="nav">
          <button type="button" onClick={() => handleNav(onDashboardClick)}>Dashboard</button>
          <button type="button" onClick={() => handleNav(onHistoryClick)}>History</button>
          <button type="button" aria-current="page" onClick={closeNav}>Analytics</button>
          <button type="button" onClick={() => handleNav(onHelpClick)}>Help</button>
          {canRegister && (
            <button type="button" onClick={() => handleNav(onRegisterClick)}>Registration</button>
          )}
        </div>
        <div className="sidebar-card">
          <h3>Signal</h3>
          <p>Routing data is refreshed every 15 minutes.</p>
        </div>
        <div className="sidebar-card">
          <h3>Exports</h3>
          <p>Download detailed reports from the analytics console.</p>
        </div>
        {userPublicKey && (
          <button type="button" className="disconnect-button" onClick={onDisconnectWallet}>
            Disconnect wallet
          </button>
        )}
      </aside>

      <main className="main">
        <section className="topbar reveal">
          <button
            type="button"
            className="hamburger"
            onClick={() => setIsNavOpen((prev) => !prev)}
            aria-label="Toggle navigation"
            aria-expanded={isNavOpen}
          >
            <span />
            <span />
            <span />
          </button>
          <div>
            <h2 className="headline">Analytics</h2>
            <p className="subtle">Monitor corridors, spikes, and routing health.</p>
          </div>
          <div className="topbar-actions">
            <span className="chip">Last 24 hours</span>
            <span className="chip">Testnet</span>
            <div className="wallet-menu" ref={menuRef}>
              <button
                type="button"
                className="connect-pill"
                onClick={() => {
                  if (userPublicKey) {
                    setIsWalletMenuOpen((prev) => !prev)
                  } else {
                    handleConnect()
                  }
                }}
                disabled={isConnecting}
                aria-expanded={isWalletMenuOpen}
              >
                {userPublicKey
                  ? `Connected: ${formatShortAddress(userPublicKey)}`
                  : isConnecting
                    ? 'Connecting...'
                    : 'Connect wallet'}
              </button>
              {userPublicKey && isWalletMenuOpen && (
                <div className="wallet-dropdown">
                  <button type="button" onClick={onDisconnectWallet}>
                    Disconnect wallet
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="grid columns-3">
          <div className="card reveal">
            <div className="card-header">
              <h2>Routing volume</h2>
              <span className="badge">+12%</span>
            </div>
            <div className="metric">88,904 <span>XLM</span></div>
            <div className="spark"></div>
          </div>
          <div className="card reveal">
            <div className="card-header">
              <h2>Avg confirmation</h2>
              <span className="badge">Stable</span>
            </div>
            <div className="metric">3.9s <span>network</span></div>
            <div className="spark"></div>
          </div>
          <div className="card reveal">
            <div className="card-header">
              <h2>Success rate</h2>
              <span className="badge">99.1%</span>
            </div>
            <div className="metric">+0.4% <span>week</span></div>
            <div className="spark"></div>
          </div>
        </section>

        <section className="grid columns-2">
          <div className="card reveal">
            <div className="card-header">
              <h2>Routing insights</h2>
              <span className="chip">Corridors</span>
            </div>
            <div className="grid">
              <div>
                <strong>Top corridor</strong>
                <div className="metric" style={{ fontSize: '22px' }}>
                  NA to EU <span>41%</span>
                </div>
              </div>
              <div>
                <strong>Peak hour</strong>
                <div className="metric" style={{ fontSize: '22px' }}>
                  14:00 UTC <span>27%</span>
                </div>
              </div>
              <div className="spark"></div>
            </div>
          </div>
          <div className="card reveal">
            <div className="card-header">
              <h2>Alerts</h2>
              <span className="chip">Live</span>
            </div>
            <div className="stack">
              <div>Fee volatility is within normal range.</div>
              <div>No stalled transactions in the last hour.</div>
              <div>Anchor liquidity remains steady across corridors.</div>
            </div>
          </div>
        </section>
      </main>
      <MobileNav
        active="analytics"
        onDashboardClick={() => handleNav(onDashboardClick)}
        onHistoryClick={() => handleNav(onHistoryClick)}
        onAnalyticsClick={closeNav}
        onHelpClick={() => handleNav(onHelpClick)}
        onRegisterClick={() => handleNav(onRegisterClick)}
        canRegister={canRegister}
      />
    </div>
  )
}

function HistoryPage({
  userPublicKey,
  setUserPublicKey,
  onConnectWallet,
  onDisconnectWallet,
  onRefreshBalance,
  onDashboardClick,
  onAnalyticsClick,
  onHelpClick,
  onRegisterClick,
  canRegister,
}) {
  const [isNavOpen, setIsNavOpen] = useNavState()
  const [isConnecting, setIsConnecting] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [history, setHistory] = useState([])
  const [expandedId, setExpandedId] = useState(null)
  const [refreshIndex, setRefreshIndex] = useState(0)
  const { menuRef, isOpen: isWalletMenuOpen, setIsOpen: setIsWalletMenuOpen } = useWalletMenu()
  const closeNav = () => {
    sessionStorage.setItem(NAV_STORAGE_KEY, 'false')
    setIsNavOpen(false)
  }
  const handleNav = (action) => {
    sessionStorage.setItem(NAV_STORAGE_KEY, 'false')
    setIsNavOpen(false)
    action()
  }

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      const result = await onConnectWallet()
      if (result?.address) {
        setUserPublicKey(result.address)
      }
    } finally {
      setIsConnecting(false)
    }
  }
  const handleDisconnect = () => {
    onDisconnectWallet()
  }

  const loadHistory = useCallback(async (signal) => {
    if (!userPublicKey) {
      setHistory([])
      setHistoryError('')
      return
    }

    setIsLoading(true)
    setHistoryError('')
    try {
      const response = await fetch(
        `${HORIZON_BASE}/accounts/${userPublicKey}/payments?order=desc&limit=25`,
        { signal, cache: 'no-store' },
      )
      if (!response.ok) {
        throw new Error(`Horizon error (${response.status}).`)
      }

      const data = await response.json()
      const records = data?._embedded?.records ?? []
      const filtered = records.filter((record) =>
        [
          'payment',
          'path_payment_strict_receive',
          'path_payment_strict_send',
          'create_account',
          'account_merge',
          'invoke_host_function',
        ].includes(record.type),
      )
      const formatted = filtered
        .flatMap((record) => {
          if (record.type === 'invoke_host_function' && record.asset_balance_changes?.length) {
            const changes = record.asset_balance_changes
              .filter((change) => change.asset_type === 'native')
              .filter((change) => change.from === userPublicKey || change.to === userPublicKey)

            return changes.map((change, index) => {
              const direction = change.from === userPublicKey ? 'Sent' : 'Received'
              const counterparty = change.from === userPublicKey ? change.to : change.from
              const amount = `${change.amount} XLM`
              const status = record.transaction_successful === false ? 'Failed' : 'Success'
              const explorerLink = record.transaction_hash
                ? `https://stellar.expert/explorer/testnet/tx/${record.transaction_hash}`
                : ''

              return {
                id: `${record.id}-${index}`,
                counterparty: counterparty || 'Unknown',
                direction,
                amount,
                status,
                type: record.type,
                createdAt: record.created_at,
                transactionHash: record.transaction_hash,
                asset: 'XLM',
                explorerLink,
              }
            })
          }

          const isSender = record.from === userPublicKey || record.account === userPublicKey
          const isReceiver = record.to === userPublicKey || record.into === userPublicKey
          const direction = isSender && !isReceiver ? 'Sent' : isReceiver ? 'Received' : 'Sent'
          const counterparty =
            direction === 'Sent'
              ? record.to || record.into || record.account || 'Unknown'
              : record.from || record.funder || record.account || 'Unknown'

          const asset = record.asset_type === 'native' ? 'XLM' : record.asset_code || 'Asset'
          const rawAmount = record.amount || record.starting_balance || ''
          const amount = rawAmount ? `${rawAmount} ${asset}` : '-'
          const status = record.transaction_successful === false ? 'Failed' : 'Success'
          const explorerLink = record.transaction_hash
            ? `https://stellar.expert/explorer/testnet/tx/${record.transaction_hash}`
            : ''

          return [
            {
              id: String(record.id),
              counterparty,
              direction,
              amount,
              status,
              type: record.type,
              createdAt: record.created_at,
              transactionHash: record.transaction_hash,
              asset,
              explorerLink,
            },
          ]
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

      const latest = formatted[0]
      if (latest?.status === 'Success') {
        const lastSeen = sessionStorage.getItem('stellar-last-tx')
        const latestKey = `${latest.transactionHash || latest.id}-${latest.amount}`
        if (latestKey !== lastSeen) {
          sessionStorage.setItem('stellar-last-tx', latestKey)
          onRefreshBalance()
        }
      }

      setHistory(formatted)
    } catch (error) {
      if (error.name !== 'AbortError') {
        setHistoryError(error.message || 'Unable to load transaction history.')
      }
    } finally {
      setIsLoading(false)
    }
  }, [onRefreshBalance, userPublicKey])

  useEffect(() => {
    const controller = new AbortController()
    loadHistory(controller.signal)
    return () => controller.abort()
  }, [loadHistory, refreshIndex, userPublicKey])

  useEffect(() => {
    const handleUpdate = () => {
      setRefreshIndex((value) => value + 1)
    }

    window.addEventListener('stellar:tx-update', handleUpdate)
    return () => window.removeEventListener('stellar:tx-update', handleUpdate)
  }, [])
  return (
    <div className={`dashboard ${isNavOpen ? 'nav-open' : ''}`}>
      <button
        type="button"
        className={`sidebar-scrim ${isNavOpen ? 'is-open' : ''}`}
        onClick={() => setIsNavOpen(false)}
        aria-label="Close navigation"
      />
      <aside className={`sidebar ${isNavOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">S</div>
          <h1>Stellar Pay</h1>
        </div>
        <div className="nav">
          <button type="button" onClick={() => handleNav(onDashboardClick)}>Dashboard</button>
          <button type="button" aria-current="page" onClick={closeNav}>History</button>
          <button type="button" onClick={() => handleNav(onAnalyticsClick)}>Analytics</button>
          <button type="button" onClick={() => handleNav(onHelpClick)}>Help</button>
          {canRegister && (
            <button type="button" onClick={() => handleNav(onRegisterClick)}>Registration</button>
          )}
        </div>
        <div className="sidebar-card">
          <h3>Timeline</h3>
          <p>Payments are archived for 90 days.</p>
        </div>
        <div className="sidebar-card">
          <h3>Filters</h3>
          <p>Sort by status, amount, or corridor.</p>
        </div>
        {userPublicKey && (
          <button type="button" className="disconnect-button" onClick={onDisconnectWallet}>
            Disconnect wallet
          </button>
        )}
      </aside>

      <main className="main">
        <section className="topbar reveal">
          <button
            type="button"
            className="hamburger"
            onClick={() => setIsNavOpen((prev) => !prev)}
            aria-label="Toggle navigation"
            aria-expanded={isNavOpen}
          >
            <span />
            <span />
            <span />
          </button>
          <div>
            <h2 className="headline">Transaction history</h2>
            <p className="subtle">Connect your wallet to review recent transactions.</p>
          </div>
          <div className="topbar-actions">
            <span className="chip">Last 24 hours</span>
            <span className="chip">Testnet</span>
            <div className="wallet-menu" ref={menuRef}>
              <button
                type="button"
                className="connect-pill"
                onClick={() => {
                  if (userPublicKey) {
                    setIsWalletMenuOpen((prev) => !prev)
                  } else {
                    handleConnect()
                  }
                }}
                disabled={isConnecting}
                aria-expanded={isWalletMenuOpen}
              >
                {userPublicKey
                  ? `Connected: ${formatShortAddress(userPublicKey)}`
                  : isConnecting
                    ? 'Connecting...'
                    : 'Connect wallet'}
              </button>
              {userPublicKey && isWalletMenuOpen && (
                <div className="wallet-dropdown">
                  <button type="button" onClick={handleDisconnect}>
                    Disconnect wallet
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="card reveal">
          <div className="card-header">
            <h2>Recent transactions</h2>
            <div className="history-actions">
              <span className="chip">Latest</span>
              <button
                type="button"
                className={`refresh-button ${isLoading ? 'is-loading' : ''}`}
                onClick={() => setRefreshIndex((value) => value + 1)}
                disabled={!userPublicKey || isLoading}
                aria-label="Refresh history"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20 12a8 8 0 1 1-2.34-5.66" />
                  <path d="M20 4v6h-6" />
                </svg>
              </button>
            </div>
          </div>
          {!userPublicKey && (
            <div className="wallet-status">
              Connect your wallet to view your transaction history.
              <button type="button" onClick={handleConnect} disabled={isConnecting}>
                {isConnecting ? 'Connecting...' : 'Connect wallet'}
              </button>
            </div>
          )}
          {userPublicKey && isLoading && (
            <div className="wallet-status">Loading transactions...</div>
          )}
          {userPublicKey && historyError && (
            <div className="wallet-status">{historyError}</div>
          )}
          {userPublicKey && !isLoading && !historyError && history.length === 0 && (
            <div className="wallet-status">No transactions found for this wallet.</div>
          )}
          {userPublicKey && !isLoading && !historyError && history.length > 0 && (
            <table className="history-table">
              <thead>
                <tr>
                  <th>Counterparty</th>
                  <th>Direction</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <Fragment key={entry.id}>
                    <tr>
                      <td>{entry.counterparty}</td>
                      <td>{entry.direction}</td>
                      <td>{entry.amount}</td>
                      <td>{entry.status}</td>
                      <td>
                        <button
                          type="button"
                          className="details-button"
                          onClick={() =>
                            setExpandedId((current) => (current === entry.id ? null : entry.id))
                          }
                        >
                          {expandedId === entry.id ? 'Hide' : 'View'}
                        </button>
                      </td>
                    </tr>
                    {expandedId === entry.id && (
                      <tr className="details-row">
                        <td colSpan={5}>
                          <div className="details-panel">
                            <div><strong>Type:</strong> {entry.type}</div>
                            <div><strong>Asset:</strong> {entry.asset}</div>
                            <div><strong>Time:</strong> {new Date(entry.createdAt).toLocaleString()}</div>
                            <div>
                              <strong>Hash:</strong>{' '}
                              {entry.transactionHash || 'Unavailable'}
                            </div>
                            {entry.explorerLink && (
                              <div>
                                <a className="details-link" href={entry.explorerLink} target="_blank" rel="noreferrer">
                                  View on Stellar Expert
                                </a>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
      <MobileNav
        active="history"
        onDashboardClick={() => handleNav(onDashboardClick)}
        onHistoryClick={closeNav}
        onAnalyticsClick={() => handleNav(onAnalyticsClick)}
        onHelpClick={() => handleNav(onHelpClick)}
        onRegisterClick={() => handleNav(onRegisterClick)}
        canRegister={canRegister}
      />
    </div>
  )
}

function MobileNav({
  active,
  onDashboardClick,
  onHistoryClick,
  onAnalyticsClick,
  onHelpClick,
  onRegisterClick,
  canRegister,
}) {
  return (
    <nav className="mobile-nav" aria-label="Primary">
      <button
        type="button"
        className={active === 'dashboard' ? 'is-active' : ''}
        onClick={onDashboardClick}
        aria-current={active === 'dashboard' ? 'page' : undefined}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z" />
        </svg>
        <span>Dashboard</span>
      </button>
      <button
        type="button"
        className={active === 'history' ? 'is-active' : ''}
        onClick={onHistoryClick}
        aria-current={active === 'history' ? 'page' : undefined}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h16M6 12h12M9 19h6" />
        </svg>
        <span>History</span>
      </button>
      <button
        type="button"
        className={active === 'analytics' ? 'is-active' : ''}
        onClick={onAnalyticsClick}
        aria-current={active === 'analytics' ? 'page' : undefined}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 19V5m5 14V9m5 10v-6m5 6V7" />
        </svg>
        <span>Analytics</span>
      </button>
      <button
        type="button"
        className={active === 'help' ? 'is-active' : ''}
        onClick={onHelpClick}
        aria-current={active === 'help' ? 'page' : undefined}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 18h.01M9.5 9.5a2.5 2.5 0 1 1 4.2 1.9c-.78.7-1.2 1.2-1.2 2.1" />
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
        <span>Help</span>
      </button>
      {canRegister && (
        <button
          type="button"
          className={active === 'register' ? 'is-active' : ''}
          onClick={onRegisterClick}
          aria-current={active === 'register' ? 'page' : undefined}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" />
            <path d="M5 21a7 7 0 0 1 14 0" />
          </svg>
          <span>Register</span>
        </button>
      )}
    </nav>
  )
}

function RegistrationPage({ userPublicKey, setUserPublicKey, onBack, onRegistered }) {
  const [username, setUsername] = useState('')
  const [status, setStatus] = useState({
    text: 'Connect a wallet to begin your registration.',
    tone: 'neutral',
  })
  const [isConnecting, setIsConnecting] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const walletLabel = userPublicKey
    ? `Connected: ${userPublicKey.substring(0, 5)}...${userPublicKey.substring(51)}`
    : 'No wallet connected'

  const setStatusMessage = (text, tone = 'neutral') => {
    setStatus({ text, tone })
  }

  useEffect(() => {
    if (!userPublicKey) {
      return
    }

    const checkExisting = async () => {
      try {
        const response = await fetch(`${API_BASE}/lookup?address=${encodeURIComponent(userPublicKey)}`)
        const rawBody = await response.text()
        const data = rawBody ? JSON.parse(rawBody) : null

        if (response.ok && data?.username) {
          onRegistered()
        }
      } catch (error) {
        // Ignore lookup errors in registration view.
      }
    }

    checkExisting()
  }, [userPublicKey, onRegistered])

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      const connectionStatus = await freighterApi.isConnected()
      const isInstalled =
        connectionStatus.isConnected !== undefined
          ? connectionStatus.isConnected
          : connectionStatus

      if (!isInstalled) {
        setStatusMessage('Freighter is not installed or locked.', 'error')
        return
      }

      const response = await freighterApi.requestAccess()
      if (response.error) {
        setStatusMessage('Wallet connection failed.', 'error')
        return
      }

      setUserPublicKey(response.address)
      setStatusMessage('Wallet connected. Pick your username.', 'success')
    } catch (error) {
      setStatusMessage('Unable to connect to Freighter.', 'error')
    } finally {
      setIsConnecting(false)
    }
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    const cleaned = username.trim()
    const normalizedUsername = normalizeNameTag(cleaned)

    if (!userPublicKey) {
      setStatusMessage('Connect a wallet before registering.', 'error')
      return
    }

    if (cleaned.length < 3) {
      setStatusMessage('Username must be at least 3 characters.', 'error')
      return
    }

    setIsSubmitting(true)
    setStatusMessage('Submitting your registration...', 'neutral')

    fetch(`${API_BASE}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: normalizedUsername,
        address: userPublicKey,
      }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error((data && data.detail) || 'Registration failed.')
        }

        return data
      })
      .then(() => {
        setStatusMessage('Username reserved and saved.', 'success')
      })
      .catch((error) => {
        setStatusMessage(error.message || 'Registration failed.', 'error')
      })
      .finally(() => {
        setIsSubmitting(false)
      })
  }

  return (
    <div className="registration">
      <section className="hero-panel">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <p className="brand-eyebrow">Stellar Pay</p>
            <h1>Claim your on-chain identity.</h1>
          </div>
        </div>
        <p className="hero-copy">
          Register a username that follows your wallet across apps, tips, and
          payments. Secure, memorable, and ready for the Stellar network.
        </p>
        <div className="pill-row">
          <span>Instant wallet link</span>
          <span>Unique username</span>
          <span>Testnet ready</span>
        </div>
        <div className="hero-card">
          <div>
            <p className="card-label">Wallet status</p>
            <p className="card-value">{walletLabel}</p>
          </div>
          <button type="button" className="ghost-button" onClick={handleConnect}>
            {isConnecting ? 'Connecting...' : 'Connect wallet'}
          </button>
        </div>
        <div className="hero-grid">
          <div>
            <h3>Own your name</h3>
            <p>Secure a username that resolves to your wallet instantly.</p>
          </div>
          <div>
            <h3>Seamless onboarding</h3>
            <p>Freighter brings you in with a single approval.</p>
          </div>
          <div>
            <h3>Verified presence</h3>
            <p>Show a trusted badge to customers and collaborators.</p>
          </div>
        </div>
      </section>

      <section className="form-panel">
        <div className="form-header">
          <h2>Registration</h2>
          <p>Choose a name that your community will recognize.</p>
        </div>
        <form className="registration-form" onSubmit={handleSubmit}>
          <label className="form-field">
            Desired username
            <input
              type="text"
              placeholder="stellarname"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <div className="helper-row">
            <span>3-18 characters, letters and numbers recommended.</span>
          </div>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Reserving...' : 'Reserve username'}
          </button>
        </form>
        <div className={`status-card ${status.tone}`}>
          <p>{status.text}</p>
        </div>
        <div className="form-footer">
          <button type="button" className="ghost-button" onClick={onBack}>
            Back to dashboard
          </button>
          <p>Wallet required to finalize registration.</p>
          <div className="badge-row">
            <span>Freighter</span>
            <span>Stellar Testnet</span>
            <span>Secure</span>
          </div>
        </div>
      </section>
    </div>
  )
}

export default App

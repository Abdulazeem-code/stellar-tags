import { useEffect, useState } from 'react'
import freighterApi from '@stellar/freighter-api'
import * as StellarSdk from 'stellar-sdk'

const CONTRACT_ID = 'CB5FYOCWBQA2PI3DQDFOTW5BSIVIMHBOVBBNXRBOASRFWWPRVRTVFXA2'
const TREASURY_ADDRESS = 'GAAFWEZKDYPXLTQGKQ3F23TXWYQUDAYTDW7P7VUQSVJFW2GWC4Y6LWST'
const TOKEN_ADDRESS = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const API_BASE = import.meta.env.VITE_API_BASE ?? ''
const DEFAULT_FEDERATION_DOMAIN = 'localhost'

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

function App() {
  const [activeView, setActiveView] = useState('dashboard')
  const [userPublicKey, setUserPublicKey] = useState('')
  const [registrationState, setRegistrationState] = useState('unknown')

  useEffect(() => {
    const syncView = () => {
      setActiveView(window.location.hash === '#register' ? 'register' : 'dashboard')
    }

    syncView()
    window.addEventListener('hashchange', syncView)
    return () => window.removeEventListener('hashchange', syncView)
  }, [])

  const handleNavigate = (view) => {
    setActiveView(view)
    window.location.hash = view === 'register' ? 'register' : ''
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

  return (
    <Dashboard
      userPublicKey={userPublicKey}
      setUserPublicKey={setUserPublicKey}
      onRegisterClick={() => handleNavigate('register')}
      onRegistrationStateChange={handleRegistrationStateChange}
      canRegister={registrationState === 'new'}
    />
  )
}

function Dashboard({
  userPublicKey,
  setUserPublicKey,
  onRegisterClick,
  onRegistrationStateChange,
  canRegister,
}) {
  const [nameTag, setNameTag] = useState('')
  const [amount, setAmount] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [isReceiving, setIsReceiving] = useState(false)
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
    const status = await freighterApi.isConnected()
    const isInstalled = status.isConnected !== undefined ? status.isConnected : status

    if (!isInstalled) {
      displayMessage('Freighter is not installed or locked.', '#DC2626', '#FEE2E2')
      return
    }

    const response = await freighterApi.requestAccess()
    if (response.error) {
      displayMessage('Wallet connection failed.', '#DC2626', '#FEE2E2')
      return
    }

    setUserPublicKey(response.address)
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

  return (
    <div className="dashboard">
      <aside className="sidebar reveal">
        <div className="brand">
          <div className="brand-mark">S</div>
          <h1>Stellar Pay</h1>
        </div>
        <div className="nav">
          <button type="button">Overview</button>
          <button type="button">Dashboard</button>
          <button type="button">History</button>
          <button type="button">Analytics</button>
          <button type="button">Help</button>
          {canRegister && (
            <button type="button" onClick={onRegisterClick}>Registration</button>
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
      </aside>

      <main className="main">
        <section className="topbar reveal">
          <div>
            <h2 className="headline">Payments, designed for stellar speed.</h2>
            <p className="subtle">
              Realtime routing, verified name tags, and a clear view of activity.
            </p>
          </div>
          <div className="topbar-actions">
            <span className="chip">Today: May 4</span>
            <span className="chip">Testnet</span>
          </div>
        </section>

        <section className="grid columns-3">
          <div className="card reveal">
            <div className="card-header">
              <h2>Current balance</h2>
              <span className="badge">+3.8% week</span>
            </div>
            <div className="metric">12,480.25 <span>XLM</span></div>
            <div className="spark"></div>
          </div>
          <div className="card reveal">
            <div className="card-header">
              <h2>Routing volume</h2>
              <span className="badge">12 routes</span>
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
        </section>

        <section className="card payment-card reveal">
          <div>
            <div className="card-header">
              <h2>Send payment</h2>
              <span className="tag">Secure routing</span>
            </div>
            {!userPublicKey && (
              <button type="button" onClick={handleConnect}>
                1. Connect wallet
              </button>
            )}
            {walletLabel && <div className="wallet-status">{walletLabel}</div>}

            {userPublicKey && (
              <div>
                <label>Recipient username or address</label>
                <input
                  type="text"
                  value={nameTag}
                  onChange={(event) => setNameTag(event.target.value)}
                  placeholder="e.g., walzeem or G..."
                  autoComplete="off"
                  disabled={isProcessing}
                />

                <label>Amount (XLM)</label>
                <input
                  type="number"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                  min="0.01"
                  step="0.01"
                  disabled={isProcessing}
                />

                <button
                  type="button"
                  className="accent-btn"
                  onClick={handleLookup}
                  disabled={isProcessing}
                >
                  {isProcessing ? 'Processing...' : '2. Verify & Pay'}
                </button>
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
          <div className="payment-cta">
            <h3>Instant name resolution</h3>
            <p>
              Verify Stellar name tags, auto-route fees, and keep every payment
              traceable in one place.
            </p>
            <div className="grid columns-2">
              <div className="card hint-card">
                <h3>Trusted routing</h3>
                <p>Each transfer is simulated before you sign.</p>
              </div>
              <div className="card hint-card">
                <h3>Always compliant</h3>
                <p>Routing fees are applied to treasury automatically.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="card reveal">
          <div className="card-header">
            <h2>Receive payment</h2>
            <span className="tag">Shareable address</span>
          </div>
          {!userPublicKey && (
            <div className="wallet-status">Connect your wallet to view your receive details.</div>
          )}
          {userPublicKey && receiveAddress && (
            <div className="receive-result">
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
            </div>
          )}
          {receiveStatus.text && (
            <div
              id="status-box"
              style={{ color: receiveStatus.color, backgroundColor: receiveStatus.bgColor }}
            >
              {receiveStatus.text}
            </div>
          )}
        </section>

        <section className="grid columns-2">
          <div className="card reveal">
            <div className="card-header">
              <h2>Recent transfers</h2>
              <span className="chip">Last 24 hours</span>
            </div>
            <table className="history-table">
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>orbit*stellar.org</td>
                  <td>1,240 XLM</td>
                  <td>Success</td>
                </tr>
                <tr>
                  <td>neon*fundable</td>
                  <td>420 XLM</td>
                  <td>Pending</td>
                </tr>
                <tr>
                  <td>flux*anchor</td>
                  <td>3,880 XLM</td>
                  <td>Success</td>
                </tr>
                <tr>
                  <td>delta*bridge</td>
                  <td>255 XLM</td>
                  <td>Success</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="card reveal">
            <div className="card-header">
              <h2>Analytics</h2>
              <span className="chip">Routing insights</span>
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
        </section>

        <section className="card reveal">
          <div className="card-header">
            <h2>Help center</h2>
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
      </main>
    </div>
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

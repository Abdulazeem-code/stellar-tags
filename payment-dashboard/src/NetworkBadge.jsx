const NETWORK = (import.meta.env.VITE_NETWORK || 'testnet').toLowerCase()
const isMainnet = NETWORK === 'mainnet' || NETWORK === 'public'

export default function NetworkBadge() {
  return (
    <span
      className={`network-badge ${isMainnet ? 'network-badge--mainnet' : 'network-badge--testnet'}`}
      aria-label={`Network: ${isMainnet ? 'Mainnet' : 'Testnet'}`}
    >
      <span className="network-badge__pulse" aria-hidden="true" />
      <span>{isMainnet ? 'Mainnet' : 'Testnet'}</span>
    </span>
  )
}

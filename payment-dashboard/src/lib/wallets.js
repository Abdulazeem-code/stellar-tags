import {
  StellarWalletsKit,
  WalletNetwork,
  allowAllModules,
} from '@creit.tech/stellar-wallets-kit';

export const NETWORK_PASSPHRASE = WalletNetwork.TESTNET;
const WALLET_ID_KEY = 'walletId';

const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';
const TREZOR_EMAIL = import.meta.env.VITE_TREZOR_EMAIL || '';

// Extension and web wallets are light, so they load with the app. Hardware
// wallets and WalletConnect pull in large SDKs, so their modules are imported
// only when someone picks them.
export const walletKit = new StellarWalletsKit({
  network: NETWORK_PASSPHRASE,
  modules: allowAllModules(),
});

const lazyModules = {
  LEDGER: async () => {
    const { LedgerModule } = await import(
      '@creit.tech/stellar-wallets-kit/modules/ledger.module.mjs'
    );
    return new LedgerModule();
  },
  TREZOR: async () => {
    const { TrezorModule } = await import(
      '@creit.tech/stellar-wallets-kit/modules/trezor.module.mjs'
    );
    return new TrezorModule({
      appUrl: window.location.origin,
      email: TREZOR_EMAIL || `support@${window.location.hostname}`,
    });
  },
  wallet_connect: async () => {
    const { WalletConnectModule, WalletConnectAllowedMethods } = await import(
      '@creit.tech/stellar-wallets-kit/modules/walletconnect.module.mjs'
    );
    return new WalletConnectModule({
      projectId: WALLETCONNECT_PROJECT_ID,
      name: 'Stellar Tags',
      description: 'Payments on Stellar, addressed by name.',
      url: window.location.origin,
      icons: [`${window.location.origin}/favicon.svg`],
      method: WalletConnectAllowedMethods.SIGN,
      network: NETWORK_PASSPHRASE,
    });
  },
};

// Display order and copy for the connect modal. `kind` is shown under the
// name; `detect` wallets are probed with isAvailable() and grouped as
// "Detected" when installed.
export const WALLETS = [
  { id: 'freighter', name: 'Freighter', kind: 'Browser extension', detect: true },
  { id: 'xbull', name: 'xBull', kind: 'Extension or web app', detect: true },
  { id: 'lobstr', name: 'LOBSTR', kind: 'Browser extension', detect: true },
  { id: 'rabet', name: 'Rabet', kind: 'Browser extension', detect: true },
  { id: 'hana', name: 'Hana', kind: 'Browser extension', detect: true },
  { id: 'albedo', name: 'Albedo', kind: 'Web signer, no install' },
  { id: 'hot-wallet', name: 'HOT Wallet', kind: 'Multichain wallet' },
  { id: 'LEDGER', name: 'Ledger', kind: 'Hardware, over USB' },
  { id: 'TREZOR', name: 'Trezor', kind: 'Hardware, Trezor Connect' },
  {
    id: 'wallet_connect',
    name: 'WalletConnect',
    kind: 'Any mobile wallet',
    disabledReason: WALLETCONNECT_PROJECT_ID
      ? ''
      : 'Not set up on this site yet',
  },
];

export const WALLET_HINTS = {
  freighter: 'Approve the connection in the Freighter popup.',
  xbull: 'Approve the request in xBull.',
  lobstr: 'Approve the request in the LOBSTR signer extension.',
  rabet: 'Approve the request in Rabet.',
  hana: 'Approve the request in Hana.',
  albedo: 'An Albedo window will ask you to confirm.',
  'hot-wallet': 'Confirm the request in HOT Wallet.',
  LEDGER: 'Plug in your Ledger, unlock it and open the Stellar app.',
  TREZOR: 'Follow the Trezor Connect window to share your address.',
  wallet_connect: 'Scan the QR code with a WalletConnect-ready Stellar wallet.',
};

async function ensureModule(id) {
  if (walletKit.modules.some((mod) => mod.productId === id)) {
    return;
  }
  const load = lazyModules[id];
  if (!load) {
    throw new Error(`Unsupported wallet: ${id}`);
  }
  walletKit.modules.push(await load());
}

/** Returns the WALLETS list with an `isAvailable` flag for detectable wallets. */
export async function detectWallets() {
  const supported = await walletKit.getSupportedWallets();
  const byId = new Map(supported.map((wallet) => [wallet.id, wallet]));
  return WALLETS.map((wallet) => {
    const info = byId.get(wallet.id);
    return {
      ...wallet,
      icon: info?.icon || '',
      url: info?.url || '',
      isAvailable: wallet.detect ? Boolean(info?.isAvailable) : true,
    };
  });
}

/** Selects a wallet, asks it for the account address and remembers the choice. */
export async function connectWallet(id) {
  await ensureModule(id);
  walletKit.setWallet(id);
  const { address } = await walletKit.getAddress();
  if (!address) {
    throw new Error('The wallet did not return an address.');
  }
  localStorage.setItem(WALLET_ID_KEY, id);
  return address;
}

export function connectedWalletId() {
  return localStorage.getItem(WALLET_ID_KEY) || '';
}

export function walletName(id) {
  return WALLETS.find((wallet) => wallet.id === id)?.name || 'Wallet';
}

async function selectStoredWallet() {
  const id = connectedWalletId() || 'freighter';
  await ensureModule(id);
  walletKit.setWallet(id);
}

export async function signTransaction(xdr, address) {
  await selectStoredWallet();
  const result = await walletKit.signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address,
  });
  return result.signedTxXdr;
}

export async function signMessage(message, address) {
  await selectStoredWallet();
  return walletKit.signMessage(message, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address,
  });
}

export async function disconnectWallet() {
  try {
    await selectStoredWallet();
    await walletKit.disconnect();
  } catch {
    // Wallets without a session to close are fine to ignore.
  }
  localStorage.removeItem(WALLET_ID_KEY);
}

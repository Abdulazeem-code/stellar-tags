import { API_BASE, HORIZON_BASE, loadStellarSdk } from '../views/shared';
import { NETWORK_PASSPHRASE } from './wallets';

// Payment links look like /pay/<tag>?amount=10&asset=CODE:ISSUER&memo=..&memoType=text&requestId=..
// The format mirrors stellar-payment-platform/src/utils/paymentLink.js.

const SEP7_MEMO_TYPES = { text: 'MEMO_TEXT', id: 'MEMO_ID', hash: 'MEMO_HASH' };

/** A positive decimal string with at most 7 decimal places (Stellar precision). */
export const isValidAmount = (value) =>
  typeof value === 'string' && /^\d+(\.\d{1,7})?$/.test(value) && Number(value) > 0;

/** Splits "CODE:ISSUER" into { code, issuer }; XLM / native gives { code: 'XLM' }. */
export const parseAsset = (asset) => {
  if (!asset || asset === 'XLM' || asset.toLowerCase() === 'native') return { code: 'XLM', issuer: null };
  const [code, issuer] = asset.split(':');
  return { code, issuer: issuer || null };
};

export const assetLabel = (asset) => parseAsset(asset).code;

/**
 * Reads the current location. Returns null when this is not a /pay/ URL,
 * otherwise { tag, amount, asset, memo, memoType, requestId }.
 */
export const readPayLocation = (location = window.location) => {
  const match = /^\/pay\/([^/]+)\/?$/.exec(location.pathname);
  if (!match) return null;
  let tag;
  try {
    tag = decodeURIComponent(match[1]).trim().toLowerCase();
  } catch {
    tag = '';
  }
  const params = new URLSearchParams(location.search);
  return {
    tag,
    amount: params.get('amount') || '',
    asset: params.get('asset') || 'XLM',
    memo: params.get('memo') || '',
    memoType: params.get('memoType') || params.get('memo_type') || '',
    requestId: params.get('requestId') || params.get('request_id') || '',
  };
};

export const isPayPath = (location = window.location) => location.pathname.startsWith('/pay/');

/** The dashboard pay link for a payment request, on this site's own origin. */
export const buildPayLink = ({ tag, amount, asset, memo, memoType, requestId }) => {
  const local = String(tag || '').split('*')[0].toLowerCase();
  const url = new URL(`/pay/${encodeURIComponent(local)}`, window.location.origin);
  if (amount) url.searchParams.set('amount', amount);
  if (asset && asset !== 'XLM') url.searchParams.set('asset', asset);
  if (memo) url.searchParams.set('memo', memo);
  if (memo && memoType) url.searchParams.set('memoType', memoType);
  if (requestId) url.searchParams.set('requestId', requestId);
  return url.toString();
};

const hexToBase64 = (hex) => {
  const bytes = hex.match(/.{2}/g)?.map((pair) => parseInt(pair, 16)) ?? [];
  return btoa(String.fromCharCode(...bytes));
};

/** A SEP-0007 web+stellar:pay URI that mobile wallets can open or scan. */
export const buildSep7Uri = ({ destination, amount, asset, memo, memoType }) => {
  const params = new URLSearchParams();
  params.set('destination', destination);
  if (amount) params.set('amount', amount);
  const { code, issuer } = parseAsset(asset);
  if (code !== 'XLM' && issuer) {
    params.set('asset_code', code);
    params.set('asset_issuer', issuer);
  }
  if (memo) {
    const type = memoType || 'text';
    params.set('memo', type === 'hash' ? hexToBase64(memo) : memo);
    params.set('memo_type', SEP7_MEMO_TYPES[type] || 'MEMO_TEXT');
  }
  return `web+stellar:pay?${params.toString()}`;
};

/** Server-rendered QR code for a saved payment request (GET /payment-requests/:id/qr.svg). */
export const requestQrUrl = (requestId, { format = 'link', size = 512 } = {}) =>
  `${API_BASE}/payment-requests/${encodeURIComponent(requestId)}/qr.svg?format=${format}&size=${size}`;

/** Renders text as an SVG data URL, for links that have no saved request. */
export const qrDataUrl = async (text) => {
  const { default: QRCode } = await import('qrcode');
  const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

export async function fetchPaymentRequest(id, { signal } = {}) {
  const response = await fetch(`${API_BASE}/payment-requests/${encodeURIComponent(id)}`, { signal });
  const body = await response.json().catch(() => null);
  if (response.status === 404) throw new Error('This payment request does not exist.');
  if (!response.ok || !body?.data) throw new Error(body?.error?.message || 'Could not load this payment request.');
  return body.data;
}

/** Resolves a bare tag through federation: { address, memo, memoType } or throws. */
export async function resolveTag(tag, { signal } = {}) {
  const response = await fetch(`${API_BASE}/federation?q=${encodeURIComponent(tag)}&type=name`, { signal });
  if (response.status === 404) throw new Error(`No wallet is registered for ${tag}.`);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.account_id) throw new Error('Could not look up this tag right now.');
  return { address: body.account_id, memo: body.memo || '', memoType: body.memo_type || '' };
}

const buildMemo = (Memo, memo, memoType) => {
  if (!memo) return Memo.none();
  if (memoType === 'id') return Memo.id(memo);
  if (memoType === 'hash') return Memo.hash(memo);
  return Memo.text(memo);
};

const HORIZON_ERRORS = {
  op_no_trust: 'The recipient cannot hold this asset yet (no trustline).',
  op_src_no_trust: 'Your account does not hold this asset.',
  op_underfunded: 'Your balance is too low for this payment.',
  op_no_destination: 'The recipient account does not exist on testnet.',
  op_line_full: 'The recipient cannot receive more of this asset.',
  tx_insufficient_balance: 'Your balance is too low to cover the payment and fee.',
  tx_bad_seq: 'Your account changed while signing. Try again.',
};

const horizonErrorMessage = (error) => {
  const codes = error?.response?.data?.extras?.result_codes;
  const ops = codes?.operations || [];
  for (const code of [...ops, codes?.transaction]) {
    if (HORIZON_ERRORS[code]) return HORIZON_ERRORS[code];
  }
  if (codes) return `The network rejected the payment (${[codes.transaction, ...ops].filter(Boolean).join(', ')}).`;
  return error?.message || 'The payment failed.';
};

/**
 * Builds a classic payment (not the Soroban router): payment requests are
 * matched by the Horizon listener on destination, asset, amount and memo.
 * Returns the unsigned transaction XDR.
 */
export async function buildPaymentXdr({ source, destination, amount, asset, memo, memoType }) {
  const { Asset, BASE_FEE, Horizon, Memo, Operation, TransactionBuilder } = await loadStellarSdk();
  const server = new Horizon.Server(HORIZON_BASE);
  let account;
  try {
    account = await server.loadAccount(source);
  } catch (error) {
    if (error?.response?.status === 404) {
      throw new Error('Your account does not exist on testnet yet. Fund it with Friendbot first.', { cause: error });
    }
    throw error;
  }
  const { code, issuer } = parseAsset(asset);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.payment({
        destination,
        asset: code === 'XLM' ? Asset.native() : new Asset(code, issuer),
        amount,
      }),
    )
    .addMemo(buildMemo(Memo, memo, memoType))
    .setTimeout(180)
    .build();
  return tx.toXDR();
}

/** Submits a signed transaction to Horizon and returns its hash. */
export async function submitPayment(signedXdr) {
  const { Horizon, TransactionBuilder } = await loadStellarSdk();
  const server = new Horizon.Server(HORIZON_BASE);
  try {
    const result = await server.submitTransaction(TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE));
    return result.hash;
  } catch (error) {
    throw new Error(horizonErrorMessage(error), { cause: error });
  }
}

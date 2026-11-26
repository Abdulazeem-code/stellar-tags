/**
 * SEP-0007 Payment URI Builder and Validator
 * Specification: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */

const StellarBase58OrEd25519Regex = /^G[A-Z2-7]{55}$/;
const AssetCodeRegex = /^[a-zA-Z0-9]{1,12}$/;
const AmountRegex = /^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/;

/**
 * Validates a Stellar public key (standard 56-character Ed25519 G-address).
 * @param {string} address
 * @returns {boolean}
 */
function isValidAddress(address) {
  return typeof address === 'string' && StellarBase58OrEd25519Regex.test(address);
}

/**
 * Validates Stellar transaction amount: positive number with at most 7 decimals.
 * @param {string|number} amount
 * @returns {{ valid: boolean, error?: string, normalized?: string }}
 */
function validateAmount(amount) {
  if (amount === undefined || amount === null || amount === '') {
    return { valid: false, error: 'Amount is required.' };
  }

  const str = String(amount).trim();
  if (!AmountRegex.test(str)) {
    return {
      valid: false,
      error: 'Invalid amount. Amount must be a positive number with up to 7 decimal places (e.g. 10 or 1.5).',
    };
  }

  const num = parseFloat(str);
  if (isNaN(num) || num <= 0) {
    return { valid: false, error: 'Amount must be greater than 0.' };
  }

  return { valid: true, normalized: str };
}

/**
 * Validates and parses an asset identifier.
 * Formats:
 * - "XLM" or native (default)
 * - "CODE" (alphanumeric 1-12 chars)
 * - "CODE:ISSUER" (issued asset with explicit issuer)
 * @param {string} [asset]
 * @returns {{ valid: boolean, error?: string, isNative: boolean, assetCode?: string, assetIssuer?: string }}
 */
function parseAsset(asset) {
  if (!asset || asset.toUpperCase() === 'XLM' || asset.toLowerCase() === 'native') {
    return { valid: true, isNative: true, assetCode: 'XLM' };
  }

  const trimmed = asset.trim();
  if (trimmed.includes(':')) {
    const [code, issuer] = trimmed.split(':');
    if (!AssetCodeRegex.test(code)) {
      return { valid: false, error: `Invalid asset code "${code}". Must be 1-12 alphanumeric characters.` };
    }
    if (!isValidAddress(issuer)) {
      return { valid: false, error: `Invalid asset issuer address "${issuer}".` };
    }
    return { valid: true, isNative: false, assetCode: code, assetIssuer: issuer };
  }

  if (!AssetCodeRegex.test(trimmed)) {
    return { valid: false, error: `Invalid asset code "${trimmed}". Must be 1-12 alphanumeric characters.` };
  }

  return { valid: true, isNative: false, assetCode: trimmed };
}

/**
 * Builds a SEP-0007 pay URI.
 * web+stellar:pay?destination=...&amount=...&asset_code=...&asset_issuer=...&memo=...&memo_type=...&network_passphrase=...
 *
 * @param {object} params
 * @param {string} params.destination - Stellar G-address
 * @param {string|number} params.amount - Transaction amount
 * @param {string} [params.asset] - Asset string ("XLM", "USDC", or "USDC:GA...")
 * @param {string} [params.memo] - Optional memo text/value
 * @param {string} [params.memoType] - Optional memo type (text, id, hash, return)
 * @param {string} [params.network] - 'public' or 'testnet' (default: 'testnet')
 * @returns {string} URL-encoded SEP-0007 URI
 */
function buildSep7PayUri(params) {
  const { destination, amount, asset, memo, memoType, network = 'testnet' } = params;

  if (!destination || typeof destination !== 'string') {
    throw new Error('Destination address is required.');
  }

  const amountValidation = validateAmount(amount);
  if (!amountValidation.valid) {
    throw new Error(amountValidation.error);
  }

  const assetInfo = parseAsset(asset);
  if (!assetInfo.valid) {
    throw new Error(assetInfo.error);
  }

  const queryParams = new URLSearchParams();
  queryParams.set('destination', destination);
  queryParams.set('amount', amountValidation.normalized);

  if (!assetInfo.isNative && assetInfo.assetCode) {
    queryParams.set('asset_code', assetInfo.assetCode);
    if (assetInfo.assetIssuer) {
      queryParams.set('asset_issuer', assetInfo.assetIssuer);
    }
  }

  if (memo) {
    queryParams.set('memo', memo);
    if (memoType) {
      queryParams.set('memo_type', memoType);
    }
  }

  // Network passphrase handling for SEP-7 if testnet
  if (network.toLowerCase() === 'testnet') {
    queryParams.set('network_passphrase', 'Test SDF Network ; September 2015');
  }

  return `web+stellar:pay?${queryParams.toString()}`;
}

module.exports = {
  isValidAddress,
  validateAmount,
  parseAsset,
  buildSep7PayUri,
};

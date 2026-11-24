const { EXIT_CODES, getNetworkPassphrase } = require('../constants');

const StellarBase58OrEd25519Regex = /^G[A-Z2-7]{55}$/;
const AssetCodeRegex = /^[a-zA-Z0-9]{1,12}$/;
const AmountRegex = /^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/;

function isValidAddress(address) {
  return typeof address === 'string' && StellarBase58OrEd25519Regex.test(address);
}

function validateAmount(amount) {
  if (amount === undefined || amount === null || amount === '') {
    const error = new Error('Amount is required.');
    error.exitCode = EXIT_CODES.USER_ERROR;
    throw error;
  }

  const str = String(amount).trim();
  if (!AmountRegex.test(str)) {
    const error = new Error('Invalid amount. Must be a positive number with up to 7 decimal places.');
    error.exitCode = EXIT_CODES.USER_ERROR;
    throw error;
  }

  const num = parseFloat(str);
  if (isNaN(num) || num <= 0) {
    const error = new Error('Amount must be greater than 0.');
    error.exitCode = EXIT_CODES.USER_ERROR;
    throw error;
  }

  return str;
}

function parseAsset(asset) {
  if (!asset || asset.toUpperCase() === 'XLM' || asset.toLowerCase() === 'native') {
    return { isNative: true, assetCode: 'XLM' };
  }

  const trimmed = asset.trim();
  if (trimmed.includes(':')) {
    const [code, issuer] = trimmed.split(':');
    if (!AssetCodeRegex.test(code)) {
      const error = new Error(`Invalid asset code "${code}". Must be 1-12 alphanumeric characters.`);
      error.exitCode = EXIT_CODES.USER_ERROR;
      throw error;
    }
    if (!isValidAddress(issuer)) {
      const error = new Error(`Invalid asset issuer address "${issuer}".`);
      error.exitCode = EXIT_CODES.USER_ERROR;
      throw error;
    }
    return { isNative: false, assetCode: code, assetIssuer: issuer };
  }

  if (!AssetCodeRegex.test(trimmed)) {
    const error = new Error(`Invalid asset code "${trimmed}". Must be 1-12 alphanumeric characters.`);
    error.exitCode = EXIT_CODES.USER_ERROR;
    throw error;
  }

  return { isNative: false, assetCode: trimmed };
}

function buildSep7Uri(params) {
  const { destination, amount, asset, memo, memoType, network = 'testnet' } = params;

  if (!destination || typeof destination !== 'string') {
    const error = new Error('Destination address is required.');
    error.exitCode = EXIT_CODES.USER_ERROR;
    throw error;
  }

  const validAmount = validateAmount(amount);
  const assetInfo = parseAsset(asset);

  const queryParams = new URLSearchParams();
  queryParams.set('destination', destination);
  queryParams.set('amount', validAmount);

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

  if (network.toLowerCase() === 'testnet') {
    queryParams.set('network_passphrase', getNetworkPassphrase('testnet'));
  }

  return `web+stellar:pay?${queryParams.toString()}`;
}

module.exports = {
  isValidAddress,
  validateAmount,
  parseAsset,
  buildSep7Uri,
};

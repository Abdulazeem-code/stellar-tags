'use strict';

const { StrKey } = require('@stellar/stellar-sdk');
const { ApiError } = require('../errors');
const { normalizeNameTag, validateMemo } = require('../utils');

const invalid = (message) => {
  throw new ApiError('INVALID_INPUT', message);
};

const validateAmount = (amount) => {
  if (typeof amount !== 'string' || !/^\d+(?:\.\d{1,7})?$/.test(amount)) {
    return invalid('amount must be a positive decimal string with at most 7 decimal places');
  }
  if (Number(amount) <= 0) {
    return invalid('amount must be a positive decimal string');
  }
  return amount;
};

const validateAsset = (asset) => {
  const value = typeof asset === 'string' ? asset.trim().toUpperCase() : '';
  if (value === '' || value === 'NATIVE' || value === 'XLM') return 'XLM';
  const match = /^([A-Za-z0-9]{1,12}):([A-Z2-7]+)$/.exec(value);
  if (!match || !StrKey.isValidEd25519PublicKey(match[2])) {
    return invalid('asset must be XLM or CODE:G... issuer');
  }
  return `${match[1]}:${match[2]}`;
};

/** Builds a shareable HTTPS payment-link URL. */
const buildPaymentLink = ({ baseUrl, tag, amount, asset = 'XLM', memo, memoType, requestId } = {}) => {
  if (!baseUrl || typeof baseUrl !== 'string') return invalid('baseUrl is required');
  if (!tag || typeof tag !== 'string') return invalid('tag is required');
  const normalizedTag = normalizeNameTag(tag).toLowerCase();
  const localTag = normalizedTag.includes('*') ? normalizedTag.split('*')[0] : normalizedTag;
  validateAmount(String(amount));
  const validAsset = validateAsset(asset);
  const memoError = validateMemo(memoType, memo);
  if (memoError) return invalid(memoError);

  const url = new URL(`/pay/${encodeURIComponent(localTag)}`, baseUrl);
  url.searchParams.set('amount', String(amount));
  if (validAsset !== 'XLM') url.searchParams.set('asset', validAsset);
  if (memo) url.searchParams.set('memo', memo);
  if (memoType) url.searchParams.set('memoType', memoType);
  if (requestId) url.searchParams.set('requestId', String(requestId));
  if (url.protocol !== 'https:' && !/^https?:\/\/localhost(?::|\/|$)/i.test(baseUrl)) {
    return invalid('baseUrl must use HTTPS');
  }
  return url.toString();
};

/** Parses a payment-link URL into its payment fields. */
const parsePaymentLink = (urlString) => {
  let url;
  try {
    url = new URL(urlString);
  } catch (_err) {
    return invalid('Invalid payment link');
  }
  const match = /^\/pay\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return invalid('Invalid payment link path');
  const tag = normalizeNameTag(decodeURIComponent(match[1])).toLowerCase();
  const amount = url.searchParams.get('amount');
  const asset = validateAsset(url.searchParams.get('asset') || 'XLM');
  validateAmount(amount);
  const memo = url.searchParams.get('memo') || undefined;
  const memoType = url.searchParams.get('memoType') || undefined;
  const requestId = url.searchParams.get('requestId') || undefined;
  const memoError = validateMemo(memoType, memo);
  if (memoError) return invalid(memoError);
  return { tag, amount, asset, memo, memoType, requestId };
};

/** Builds a SEP-0007 web+stellar:pay URI. */
const toSep7Uri = ({ destination, amount, asset = 'XLM', memo, memoType } = {}) => {
  if (!destination || !StrKey.isValidEd25519PublicKey(destination)) {
    return invalid('destination must be a valid Stellar public key');
  }
  validateAmount(String(amount));
  const validAsset = validateAsset(asset);
  const memoError = validateMemo(memoType, memo);
  if (memoError) return invalid(memoError);

  const params = new URLSearchParams();
  params.set('destination', destination);
  if (amount !== undefined) params.set('amount', String(amount));
  if (validAsset !== 'XLM') {
    const [assetCode, assetIssuer] = validAsset.split(':');
    params.set('asset_code', assetCode);
    params.set('asset_issuer', assetIssuer);
  }
  if (memo) params.set('memo', memo);
  if (memoType) params.set('memo_type', memoType);
  return `web+stellar:pay?${params.toString()}`;
};

module.exports = { buildPaymentLink, parsePaymentLink, toSep7Uri };

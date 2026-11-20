'use strict';

const { StrKey } = require('@stellar/stellar-sdk');
const { ApiError } = require('../errors');
const { normalizeNameTag, validateMemo } = require('../utils');

const invalid = (message) => new ApiError('INVALID_INPUT', message);

const validateAmount = (amount) => {
  if (typeof amount !== 'string') {
    throw invalid('amount must be a positive decimal string');
  }
  if (!/^(?:0*[1-9]\d*)(?:\.\d{1,7})?$/.test(amount)) {
    throw invalid('amount must be a positive decimal string with at most 7 decimal places');
  }
};

const validateAsset = (asset) => {
  if (asset === undefined || asset === null) return 'XLM';
  if (typeof asset !== 'string') throw invalid('asset must be XLM or CODE:ISSUER');

  const value = asset.trim();
  if (value === 'XLM' || value.toLowerCase() === 'native') return 'XLM';

  const parts = value.split(':');
  if (parts.length !== 2) throw invalid('asset must be XLM or CODE:ISSUER');
  const [code, issuer] = parts;
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    throw invalid('asset code must contain 1 to 12 alphanumeric characters');
  }
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    throw invalid('asset issuer must be a valid Stellar G... public key');
  }
  return `${code}:${issuer}`;
};

const validateMemoFields = (memo, memoType) => {
  const error = validateMemo(memoType, memo);
  if (error) throw invalid(error);
};

/** Build an HTTPS shareable payment link. */
const buildPaymentLink = ({
  baseUrl,
  tag,
  amount,
  asset = 'XLM',
  memo,
  memoType,
  requestId,
} = {}) => {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw invalid('baseUrl is required');
  }

  let base;
  try {
    base = new URL(baseUrl);
  } catch (_error) {
    throw invalid('baseUrl must be a valid HTTPS URL');
  }
  if (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && (base.hostname === 'localhost' || base.hostname === '127.0.0.1'))) {
    throw invalid('baseUrl must use HTTPS');
  }

  if (typeof tag !== 'string' || tag.trim() === '') {
    throw invalid('tag is required');
  }
  validateAmount(amount);
  const normalizedAsset = validateAsset(asset);
  validateMemoFields(memo, memoType);

  const normalizedTag = normalizeNameTag(tag).toLowerCase();
  const localTag = normalizedTag.split('*', 1)[0];
  const url = new URL(`/pay/${encodeURIComponent(localTag)}`, base);
  url.searchParams.set('amount', amount);
  if (normalizedAsset !== 'XLM') url.searchParams.set('asset', normalizedAsset);
  if (memo !== undefined) url.searchParams.set('memo', memo);
  if (memoType !== undefined) url.searchParams.set('memoType', memoType);
  if (requestId !== undefined) url.searchParams.set('requestId', String(requestId));
  return url.toString();
};

/** Parse a shareable payment link into payment fields. */
const parsePaymentLink = (url) => {
  if (typeof url !== 'string') throw invalid('url must be a valid payment link');

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_error) {
    throw invalid('url must be a valid payment link');
  }
  if (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))) {
    throw invalid('payment link must use HTTPS');
  }

  const match = /^\/pay\/([^/]+)\/?$/.exec(parsed.pathname);
  if (!match) throw invalid('invalid payment link path');

  let localTag;
  try {
    localTag = decodeURIComponent(match[1]);
  } catch (_error) {
    throw invalid('invalid payment link tag');
  }
  if (!localTag) throw invalid('tag is required');

  const amount = parsed.searchParams.get('amount');
  validateAmount(amount);
  const asset = validateAsset(parsed.searchParams.get('asset') || 'XLM');
  const memo = parsed.searchParams.get('memo') || undefined;
  const memoType = parsed.searchParams.get('memoType') ||
    parsed.searchParams.get('memo_type') || undefined;
  validateMemoFields(memo, memoType);

  const requestId = parsed.searchParams.get('requestId') ||
    parsed.searchParams.get('request_id') || undefined;

  return {
    tag: normalizeNameTag(localTag).toLowerCase(),
    amount,
    asset,
    memo,
    memoType,
    requestId,
  };
};

/** Build a SEP-0007 web+stellar:pay URI. */
const toSep7Uri = ({
  destination,
  amount,
  asset = 'XLM',
  memo,
  memoType,
} = {}) => {
  if (typeof destination !== 'string' || !StrKey.isValidEd25519PublicKey(destination)) {
    throw invalid('destination must be a valid Stellar G... public key');
  }
  validateAmount(amount);
  const normalizedAsset = validateAsset(asset);
  validateMemoFields(memo, memoType);

  const params = new URLSearchParams();
  params.set('destination', destination);
  params.set('amount', amount);
  if (normalizedAsset !== 'XLM') {
    const separator = normalizedAsset.indexOf(':');
    params.set('asset_code', normalizedAsset.slice(0, separator));
    params.set('asset_issuer', normalizedAsset.slice(separator + 1));
  }
  if (memo !== undefined) params.set('memo', memo);
  if (memoType !== undefined) params.set('memo_type', memoType);

  return `web+stellar:pay?${params.toString()}`;
};

module.exports = { buildPaymentLink, parsePaymentLink, toSep7Uri };

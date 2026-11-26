const { EXIT_CODES } = require('../constants');

/**
 * Normalizes a tag query. If no domain suffix is present (no '*'), appends the default domain.
 * @param {string} tag
 * @param {string} defaultDomain
 * @returns {string}
 */
function normalizeTag(tag, defaultDomain) {
  if (!tag) return '';
  const trimmed = tag.trim().toLowerCase();
  if (trimmed.includes('*')) {
    return trimmed;
  }
  return `${trimmed}*${defaultDomain}`;
}

/**
 * Shortens a Stellar address for human display.
 * @param {string} address
 * @returns {string}
 */
function shortenAddress(address) {
  if (!address || typeof address !== 'string') return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

/**
 * Resolves a tag via public GET /federation?q=<tag>*<domain>&type=name
 * @param {string} tag
 * @param {object} options
 * @param {typeof fetch} [fetchFn=fetch]
 * @returns {Promise<object>}
 */
async function resolveTag(tag, options, fetchFn = fetch) {
  const query = normalizeTag(tag, options.domain);
  const base = (options.api || 'http://localhost:3000').replace(/\/+$/, '');
  const url = `${base}/federation?q=${encodeURIComponent(query)}&type=name`;

  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    const error = new Error(`Federation service unreachable at ${url}: ${err.message}`);
    error.exitCode = EXIT_CODES.NETWORK_ERROR;
    throw error;
  }

  if (response.status === 404) {
    const error = new Error(`Tag "${tag}" not found.`);
    error.exitCode = EXIT_CODES.USER_ERROR;
    throw error;
  }

  if (response.status === 403) {
    const error = new Error(`Tag "${tag}" is blocked or forbidden.`);
    error.exitCode = EXIT_CODES.USER_ERROR;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`Federation API responded with HTTP status ${response.status}.`);
    error.exitCode = EXIT_CODES.NETWORK_ERROR;
    throw error;
  }

  const data = await response.json();
  const accountId = data.account_id || data.stellar_address;
  if (!accountId) {
    const error = new Error('Invalid federation response: missing account_id.');
    error.exitCode = EXIT_CODES.NETWORK_ERROR;
    throw error;
  }

  return {
    tag,
    federationQuery: query,
    accountId,
    stellarAddress: data.stellar_address || accountId,
    memo: data.memo || null,
    memoType: data.memo_type || null,
  };
}

/**
 * Looks up an address via public GET /lookup?address=<G...address>
 * @param {string} address
 * @param {object} options
 * @param {typeof fetch} [fetchFn=fetch]
 * @returns {Promise<object>}
 */
async function lookupAddress(address, options, fetchFn = fetch) {
  const base = (options.api || 'http://localhost:3000').replace(/\/+$/, '');
  const url = `${base}/lookup?address=${encodeURIComponent(address)}`;

  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    const error = new Error(`API service unreachable at ${url}: ${err.message}`);
    error.exitCode = EXIT_CODES.NETWORK_ERROR;
    throw error;
  }

  if (response.status === 404) {
    const error = new Error(`No tag found registered for address "${address}".`);
    error.exitCode = EXIT_CODES.USER_ERROR;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`Lookup API responded with HTTP status ${response.status}.`);
    error.exitCode = EXIT_CODES.NETWORK_ERROR;
    throw error;
  }

  const data = await response.json();
  return data;
}

module.exports = {
  normalizeTag,
  shortenAddress,
  resolveTag,
  lookupAddress,
};

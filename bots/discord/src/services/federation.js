/**
 * Federation lookup service for Stellar Tags
 */

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
 * Shortens a Stellar public address for display (e.g. GABC...XYZ).
 * @param {string} address
 * @returns {string}
 */
function shortenAddress(address) {
  if (!address || typeof address !== 'string') return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

/**
 * Resolves a tag via the Stellar Tags Federation API.
 * @param {string} tag
 * @param {object} config
 * @param {typeof fetch} [fetchFn=fetch]
 * @returns {Promise<{ accountId: string, memo?: string, memoType?: string, stellarAddress: string }>}
 */
async function resolveTag(tag, config, fetchFn = fetch) {
  const query = normalizeTag(tag, config.domain);
  const url = `${config.apiBase}/federation?q=${encodeURIComponent(query)}&type=name`;

  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    const error = new Error(`Federation service is unreachable: ${err.message}`);
    error.code = 'SERVICE_UNAVAILABLE';
    throw error;
  }

  if (response.status === 404) {
    const error = new Error(`Tag "${tag}" not found.`);
    error.code = 'TAG_NOT_FOUND';
    throw error;
  }

  if (response.status === 403) {
    const error = new Error(`Tag "${tag}" is blocked or forbidden.`);
    error.code = 'TAG_BLOCKED';
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`Federation lookup failed with HTTP ${response.status}.`);
    error.code = 'FEDERATION_ERROR';
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const accountId = data.account_id || data.stellar_address;
  if (!accountId) {
    const error = new Error(`Invalid response from federation service: missing account_id.`);
    error.code = 'INVALID_RESPONSE';
    throw error;
  }

  return {
    accountId,
    stellarAddress: data.stellar_address || accountId,
    memo: data.memo,
    memoType: data.memo_type,
  };
}

module.exports = {
  normalizeTag,
  shortenAddress,
  resolveTag,
};

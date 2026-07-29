'use strict';

const NodeCache = require('node-cache');

const FEDERATION_TTL = 300; // 5 minutes

const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

async function lookupCached(key, fetchFn) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = await fetchFn();
  if (result !== null) cache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Federation cache helpers
// Cache keys:
//   federation:name:<username>  — for type=name lookups (username → address)
//   federation:id:<address>     — for type=id lookups  (address → username)
// TTL is 5 minutes (300s), independent of the default 10-minute stdTTL.
// ---------------------------------------------------------------------------

function federationNameKey(username) {
  return `federation:name:${username.toLowerCase()}`;
}

function federationIdKey(address) {
  return `federation:id:${address}`;
}

/**
 * Get a cached federation response, or fetch + cache it.
 *
 * @param {string} key      - Cache key (use federationNameKey / federationIdKey)
 * @param {Function} fetchFn - Async function that returns the response object or null
 * @returns {Promise<object|null>}
 */
async function federationLookupCached(key, fetchFn) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = await fetchFn();
  if (result !== null && result !== undefined) {
    cache.set(key, result, FEDERATION_TTL);
  }
  return result;
}

/**
 * Invalidate all federation cache entries for a given username and/or address.
 * Call this after any user create, update, block, or delete operation.
 *
 * @param {string} [username]
 * @param {string} [address]
 */
function invalidateFederationCache(username, address) {
  if (username) cache.del(federationNameKey(username));
  if (address) cache.del(federationIdKey(address));
}

module.exports = {
  cache,
  lookupCached,
  federationNameKey,
  federationIdKey,
  federationLookupCached,
  invalidateFederationCache,
  FEDERATION_TTL,
};

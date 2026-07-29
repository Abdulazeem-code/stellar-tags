'use strict';

const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

async function lookupCached(key, fetchFn) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = await fetchFn();
  if (result !== null) cache.set(key, result);
  return result;
}

module.exports = { cache, lookupCached };

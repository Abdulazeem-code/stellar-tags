/* global open, __ENV */
import http from 'k6/http';
import { check } from 'k6';
import { getBaseUrl, parseDuration, parseVUs, createStages, defaultThresholds } from './common.js';

// Load seed data
const usernamesRaw = open('./usernames.txt');
const usernames = usernamesRaw
  .split('\n')
  .map((u) => u.trim())
  .filter((u) => u.length > 0);

const addressesRaw = open('./addresses.txt');
const addresses = addressesRaw
  .split('\n')
  .map((a) => a.trim())
  .filter((a) => a.length > 0);

if (usernames.length === 0 || addresses.length === 0) {
  throw new Error('usernames.txt or addresses.txt is empty. Please run "node export-data.js" to populate them.');
}

const env = typeof __ENV !== 'undefined' ? __ENV : {};
const BASE_URL = getBaseUrl();
const VUS = parseVUs(env.VUS, 25);
const DURATION = parseDuration(env.DURATION, '30s');

export const options = {
  stages: createStages(VUS, DURATION),
  thresholds: {
    ...defaultThresholds,
    'http_req_duration{name:GET /federation}': ['p(95)<200'],
    'http_req_duration{name:GET /lookup}': ['p(95)<200'],
    'http_req_duration{name:GET /.well-known/stellar.toml}': ['p(95)<200'],
    'http_req_duration{name:GET /health}': ['p(95)<200'],
  },
};

export default function () {
  // Realistic mix distribution:
  // 80% federation, 10% lookup, 5% /.well-known/stellar.toml, 5% /health
  const rand = Math.random();

  if (rand < 0.80) {
    // 80%: Federation Name Lookup
    const username = usernames[Math.floor(Math.random() * usernames.length)];
    const url = `${BASE_URL}/federation?q=${encodeURIComponent(username)}&type=name`;
    const res = http.get(url, {
      headers: { Accept: 'application/json' },
      tags: { name: 'GET /federation' },
    });
    check(res, {
      'federation status is 200': (r) => r.status === 200,
    });
  } else if (rand < 0.90) {
    // 10%: Address Lookup
    const address = addresses[Math.floor(Math.random() * addresses.length)];
    const url = `${BASE_URL}/lookup?address=${encodeURIComponent(address)}`;
    const res = http.get(url, {
      headers: { Accept: 'application/json' },
      tags: { name: 'GET /lookup' },
    });
    check(res, {
      'lookup status is 200': (r) => r.status === 200,
    });
  } else if (rand < 0.95) {
    // 5%: Stellar TOML
    const url = `${BASE_URL}/.well-known/stellar.toml`;
    const res = http.get(url, {
      tags: { name: 'GET /.well-known/stellar.toml' },
    });
    check(res, {
      'stellar.toml status is 200': (r) => r.status === 200,
    });
  } else {
    // 5%: Health Check
    const url = `${BASE_URL}/health`;
    const res = http.get(url, {
      tags: { name: 'GET /health' },
    });
    check(res, {
      'health status is 200': (r) => r.status === 200,
    });
  }
}

import http from 'k6/http';
import { check } from 'k6';
import { getBaseUrl, parseDuration, parseVUs, createStages, defaultThresholds } from './common.js';

// Load addresses list
const addressesRaw = open('./addresses.txt');
const addresses = addressesRaw
  .split('\n')
  .map((a) => a.trim())
  .filter((a) => a.length > 0);

if (addresses.length === 0) {
  throw new Error('addresses.txt is empty. Please run "node export-data.js" to populate addresses.txt');
}

const BASE_URL = getBaseUrl();
const VUS = parseVUs(__ENV.VUS, 20);
const DURATION = parseDuration(__ENV.DURATION, '30s');

export const options = {
  stages: createStages(VUS, DURATION),
  thresholds: defaultThresholds,
};

export default function () {
  const address = addresses[Math.floor(Math.random() * addresses.length)];
  const url = `${BASE_URL}/lookup?address=${encodeURIComponent(address)}`;

  const res = http.get(url, {
    headers: {
      Accept: 'application/json',
    },
    tags: { name: 'GET /lookup' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has username': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Boolean(body.username);
      } catch {
        return false;
      }
    },
  });
}

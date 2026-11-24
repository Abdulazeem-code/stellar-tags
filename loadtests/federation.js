/* global open, __ENV */
import http from 'k6/http';
import { check } from 'k6';
import { getBaseUrl, parseDuration, parseVUs, createStages, defaultThresholds } from './common.js';

// Load usernames list
const usernamesRaw = open('./usernames.txt');
const usernames = usernamesRaw
  .split('\n')
  .map((u) => u.trim())
  .filter((u) => u.length > 0);

if (usernames.length === 0) {
  throw new Error('usernames.txt is empty. Please run "node export-data.js" to populate usernames.txt');
}

const env = typeof __ENV !== 'undefined' ? __ENV : {};
const BASE_URL = getBaseUrl();
const VUS = parseVUs(env.VUS, 20);
const DURATION = parseDuration(env.DURATION, '30s');

export const options = {
  stages: createStages(VUS, DURATION),
  thresholds: defaultThresholds,
};

export default function () {
  // Pick a username at random
  const username = usernames[Math.floor(Math.random() * usernames.length)];
  const url = `${BASE_URL}/federation?q=${encodeURIComponent(username)}&type=name`;

  const res = http.get(url, {
    headers: {
      Accept: 'application/json',
    },
    tags: { name: 'GET /federation' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has stellar_address or account_id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Boolean(body.stellar_address || body.account_id);
      } catch {
        return false;
      }
    },
  });
}

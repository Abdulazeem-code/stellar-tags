/* global __ENV */
// loadtests/common.js
// Shared helpers, configuration, and security validations for k6 load tests

export function getBaseUrl() {
  const env = typeof __ENV !== 'undefined' ? __ENV : {};
  const url = (env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  validateLocalBaseUrl(url);
  return url;
}

export function validateLocalBaseUrl(url) {
  const env = typeof __ENV !== 'undefined' ? __ENV : {};
  const allowRemote = env.ALLOW_REMOTE === '1' || env.ALLOW_REMOTE === 'true';
  if (allowRemote) {
    return;
  }

  const isLocal =
    url.startsWith('http://localhost') ||
    url.startsWith('https://localhost') ||
    url.startsWith('http://127.0.0.1') ||
    url.startsWith('https://127.0.0.1') ||
    url.startsWith('http://0.0.0.0') ||
    url.startsWith('http://[::1]') ||
    url.startsWith('http://host.docker.internal');

  if (!isLocal) {
    throw new Error(
      `Safety Check Failed: BASE_URL "${url}" does not point to a local address.\n` +
      `Refusing to run load tests against a non-local target unless ALLOW_REMOTE=1 is explicitly set.`
    );
  }
}

export function parseDuration(val, fallback) {
  return val ? String(val) : fallback;
}

export function parseVUs(val, fallback) {
  const parsed = parseInt(val, 10);
  return isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export function createStages(maxVus, durationStr) {
  return [
    { duration: '10s', target: maxVus },   // Ramp-up
    { duration: durationStr, target: maxVus }, // Hold
    { duration: '10s', target: 0 },       // Ramp-down
  ];
}

export const defaultThresholds = {
  // Thresholds: p95 latency under 200ms and error rate under 1% for federation on a local Docker stack
  http_req_duration: ['p(95)<200'],
  http_req_failed: ['rate<0.01'],
};


const IORedis = require('ioredis');

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const DEFAULT_CLUSTER_PORT = 6379;

/**
 * BullMQ workers issue blocking commands (BRPOPLPUSH / BZPOPMIN) that ioredis
 * refuses to queue unless `maxRetriesPerRequest` is null. The same option is
 * required by both the standalone and the cluster client.
 */
const BLOCKING_SAFE_OPTIONS = Object.freeze({ maxRetriesPerRequest: null });

/**
 * Per-connection failover hardening, applied to every node in both modes.
 * `retryStrategy` keeps reconnecting instead of giving up, the offline queue
 * makes a command issued during a blip wait for the reconnection rather than
 * fail, and `reconnectOnError` forces a fresh connection when a node answers as
 * a read-only replica so a promoted-primary change is picked up.
 */
const FAILOVER_REDIS_OPTIONS = Object.freeze({
  enableOfflineQueue: true,
  enableReadyCheck: true,
  connectTimeout: 10_000,
  retryStrategy: (times) => Math.min(100 * 2 ** times, 2_000),
  reconnectOnError: (error) => /READONLY|CLUSTERDOWN/i.test(String(error && error.message)),
});

/**
 * Cluster-level failover options. `scaleReads: 'master'` keeps BullMQ's job
 * state and lock reads on primaries — reading them from a stale replica would
 * make the queue misreport job state — while `clusterRetryStrategy` retries the
 * topology refresh with a bounded backoff during a failover.
 */
const FAILOVER_CLUSTER_OPTIONS = Object.freeze({
  enableReadyCheck: true,
  scaleReads: 'master',
  clusterRetryStrategy: (times) => Math.min(100 * 2 ** times, 2_000),
});

const TRANSIENT_REDIS_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'CONNECTION_BROKEN',
  'NR_CLOSED',
  'CLUSTERDOWN',
  'TRYAGAIN',
  'LOADING',
  'READONLY',
  'MOVED',
  'ASK',
]);

const TRANSIENT_REDIS_MESSAGE_PATTERN =
  /CLUSTERDOWN|TRYAGAIN|LOADING|READONLY|MOVED|ASK |Connection is closed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i;

/**
 * Parse one cluster node entry. Accepts `host:port`, `redis://host:port` and
 * `rediss://host:port` (the last one enabling TLS for that node) and returns
 * `null` for anything unusable so a typo cannot produce a half-broken topology.
 */
const parseClusterNode = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;

  // Reject an explicit non-redis scheme (http://, postgres://, ...) instead of
  // gluing `redis://` in front of it and silently producing a bogus host.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (hasScheme && !/^rediss?:\/\//i.test(raw)) return null;

  const withScheme = hasScheme ? raw : `redis://${raw}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (!/^rediss?:$/.test(parsed.protocol) || !parsed.hostname) return null;

  const port = parsed.port ? Number(parsed.port) : DEFAULT_CLUSTER_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const node = { host: parsed.hostname, port };
  if (parsed.protocol === 'rediss:') node.tls = {};
  return node;
};

/**
 * Parse REDIS_CLUSTER_NODES (comma-separated) into ioredis Cluster seed nodes,
 * dropping blanks, malformed entries and duplicates.
 */
const parseClusterNodes = (value) => {
  const nodes = [];
  const seen = new Set();

  for (const part of String(value || '').split(',')) {
    const node = parseClusterNode(part);
    if (!node) continue;

    const key = `${node.host}:${node.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push(node);
  }

  return nodes;
};

const getClusterNodes = () => parseClusterNodes(process.env.REDIS_CLUSTER_NODES);

/** True when REDIS_CLUSTER_NODES advertises at least one usable node. */
const isClusterMode = () => getClusterNodes().length > 0;

/**
 * Create a BullMQ-compatible Redis connection.
 *
 * When REDIS_CLUSTER_NODES is set the returned client is an ioredis Cluster
 * covering the advertised shards; otherwise the historical single-instance
 * REDIS_URL client is returned.
 */
const createRedisConnection = () => {
  const nodes = getClusterNodes();

  if (nodes.length > 0) {
    return new IORedis.Cluster(nodes, {
      ...BLOCKING_SAFE_OPTIONS,
      ...FAILOVER_CLUSTER_OPTIONS,
      redisOptions: { ...BLOCKING_SAFE_OPTIONS, ...FAILOVER_REDIS_OPTIONS },
    });
  }

  return new IORedis(process.env.REDIS_URL || DEFAULT_REDIS_URL, {
    ...BLOCKING_SAFE_OPTIONS,
    ...FAILOVER_REDIS_OPTIONS,
  });
};

/** True for errors that a retry against a healthy node can plausibly fix. */
const isTransientRedisError = (error) => {
  if (!error) return false;
  if (TRANSIENT_REDIS_CODES.has(String(error.code || ''))) return true;
  return TRANSIENT_REDIS_MESSAGE_PATTERN.test(String(error.message || ''));
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a Redis-backed operation with bounded exponential backoff, retrying only
 * transient/connection errors. During a cluster failover a job enqueue that
 * lands on the failing shard is retried against a surviving one instead of
 * being dropped, which is what keeps the queue from losing jobs.
 */
const withRedisRetry = async (
  operation,
  { attempts = 5, baseDelayMs = 50, sleep = defaultSleep, onRetry } = {},
) => {
  if (typeof operation !== 'function') {
    throw new TypeError('withRedisRetry requires an operation function');
  }

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= attempts || !isTransientRedisError(error)) {
        throw error;
      }

      if (typeof onRetry === 'function') onRetry(error, attempt);
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
};

module.exports = {
  createRedisConnection,
  parseClusterNodes,
  isClusterMode,
  isTransientRedisError,
  withRedisRetry,
  DEFAULT_REDIS_URL,
  DEFAULT_CLUSTER_PORT,
  BLOCKING_SAFE_OPTIONS,
  FAILOVER_REDIS_OPTIONS,
  FAILOVER_CLUSTER_OPTIONS,
};

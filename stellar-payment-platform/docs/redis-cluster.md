# Redis Cluster (high availability for the BullMQ webhook queue)

The webhook delivery queue used to run against a single Redis instance. Losing
that instance means losing the queue: enqueues fail and in-flight deliveries
stop being claimed. This documents the cluster mode that replaces it.

## How it is selected

`stellar-payment-platform/src/config/redis.js` builds the BullMQ connection:

| Environment | Client |
| --- | --- |
| `REDIS_CLUSTER_NODES` set to at least one usable node | `ioredis.Cluster` across the advertised shards |
| otherwise | single instance from `REDIS_URL` (default `redis://127.0.0.1:6379`) |

`REDIS_CLUSTER_NODES` is a comma-separated seed list and accepts
`host:port`, `redis://host:port` and `rediss://host:port` (TLS). Blank,
duplicate and malformed entries are dropped; if nothing usable is left, the
connection falls back to `REDIS_URL` rather than starting half-configured.

```
REDIS_CLUSTER_NODES="redis-cluster-1:6379,redis-cluster-2:6379,redis-cluster-3:6379"
```

Both the queue producer and the worker use it, so jobs are written and claimed
through the same topology:

```js
const { createRedisConnection } = require('./config/redis');
const queue = new Queue('webhook-deliveries', { connection: createRedisConnection() });
```

## Why a failover does not lose jobs

* **Blocking-command safe options** — `maxRetriesPerRequest: null` is required
  by BullMQ for the blocking commands it issues, in cluster mode too.
* **Offline queue + reconnect backoff** — a command issued while the cluster
  redirects traffic (`retryStrategy`, `enableOfflineQueue`) waits for the
  reconnection instead of failing, and `reconnectOnError` drops a connection
  that answers as a read-only replica so the promoted primary is picked up.
* **`scaleReads: 'master'`** — BullMQ's job state and locks are always read
  from a primary; a stale replica would misreport job state.
* **`clusterRetryStrategy`** — the slot-map refresh is retried with a bounded
  backoff while the cluster settles.
* **`withRedisRetry`** — `enqueueWebhookDelivery` retries the `queue.add` call
  for errors a retry can actually fix (dropped connections, `CLUSTERDOWN`,
  `MOVED`/`ASK` redirects, `READONLY`, `LOADING`, `TRYAGAIN`) and fails fast on
  permanent ones such as `WRONGTYPE`. That is the difference between a delivery
  that survives a node failing over and one that is silently dropped.

## Local cluster

`docker-compose.yml` ships a six-node cluster (three primaries, three
replicas) behind the `cluster` profile:

```bash
docker compose --profile cluster up -d          # 6 nodes + redis-cluster-init
docker compose --profile cluster down -v        # reset the slot map and data
```

`redis-cluster-init` waits for all six nodes to answer `PING`, then runs
`redis-cli --cluster create ... --cluster-replicas 1`. Re-running it against an
existing cluster is a no-op.

To run the API against it, add the profile and pass the seeds through the host
environment — the `backend` service forwards `REDIS_CLUSTER_NODES`:

```bash
REDIS_CLUSTER_NODES=redis-cluster-1:6379,redis-cluster-2:6379,redis-cluster-3:6379 \
  docker compose --profile dev --profile cluster up
```

The clients must sit on the compose network. Cluster redirects advertise
container IPs, so the host-published ports (7001-7006) are only useful for
`redis-cli` troubleshooting on the network itself.

### Exercising a failover

```bash
docker compose --profile cluster up -d
# 1. enqueue deliveries through the API
# 2. kill a primary holding a webhook-delivery slot
docker compose --profile cluster stop redis-cluster-1
# 3. its replica is promoted; enqueues keep succeeding through withRedisRetry
docker compose --profile cluster start redis-cluster-1
```

## Tests

* `tests/redis-config.test.js` — node parsing, cluster vs single-instance
  selection, and the connection options handed to ioredis.
* `tests/redis-failover.test.js` — transient vs permanent error classification,
  retry/backoff behaviour and fail-fast on permanent errors.
* `tests/webhook-worker.test.js` — enqueues are routed through the retry helper
  with the BullMQ job options unchanged.

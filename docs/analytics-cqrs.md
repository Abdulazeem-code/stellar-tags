# Analytics (CQRS)

How admin analytics are served from a separate TimescaleDB read model fed by Redis Streams.

> Back to the [README](../README.md).

Complex aggregation queries for the admin analytics dashboard are separated from the primary transactional database using Command Query Responsibility Segregation (CQRS).

## How it works

```text
[ Payment Write Path ]
  POST /payments → Prisma → PostgreSQL (write model)
         │
         │  Redis Streams XADD  (async, non-blocking)
         ▼
[ Message Broker: Redis Streams `analytics` ]
         │
         │  XREADGROUP (analytics-processors group)
         ▼
[ Analytics Consumer: analytics-worker.js ]
         │
         │  INSERT / ON CONFLICT UPDATE
         ▼
[ Analytics Read Model: TimescaleDB ]
  payment_analytics        (raw events, hypertable)
  payment_analytics_daily  (pre-aggregated daily rollup)
         │
         │  SQL query
         ▼
[ GET /admin/stats/routing ]  ← reads from TimescaleDB, not PostgreSQL
```

## Components

| Component | File | Description |
|---|---|---|
| Event Publisher | `src/analytics/eventPublisher.js` | Publishes `payment.created` / `payment.updated` events to the `analytics` Redis stream |
| Analytics Consumer | `src/analytics/analyticsConsumer.js` | XREADGROUP consumer that reads from the stream and writes to TimescaleDB |
| Analytics Repository | `src/analytics/analyticsRepository.js` | Pool, DDL bootstrap, upsert, and aggregation query against TimescaleDB |
| Analytics Worker | `analytics-worker.js` | Standalone worker process entry point (mirrors `fraud-worker.js`) |
| Publisher Middleware | `src/middleware/analyticsPublisher.js` | Express middleware for fire-and-forget event publishing on response |

## Fallback behaviour

When `ANALYTICS_DATABASE_URL` is not set (e.g. local development without TimescaleDB), `GET /admin/stats/routing` automatically falls back to querying the primary PostgreSQL database via Prisma, preserving backward compatibility.

## Running the analytics stack locally

```bash
# Start with TimescaleDB and the analytics worker
docker compose --profile dev up

# The analytics-worker starts automatically in the dev profile.
# It initialises the TimescaleDB schema on startup and begins
# consuming from the Redis Streams analytics channel.
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANALYTICS_DATABASE_URL` | _(unset)_ | TimescaleDB connection string |
| `ANALYTICS_STREAM` | `analytics` | Redis stream name for payment events |
| `ANALYTICS_CONSUMER_GROUP` | `analytics-processors` | Redis consumer group |
| `ANALYTICS_STREAM_MAX_LEN` | `10000` | Approximate max entries kept in the stream |
| `ANALYTICS_POOL_MAX` | `5` | Max connections in the TimescaleDB pool |

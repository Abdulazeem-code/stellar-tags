# Grafana Dashboard - DB Pool Monitoring

This document describes the Grafana dashboard for monitoring the Stellar Tags
database connection pool and system resources.

## Prerequisites

1. A running [Prometheus](https://prometheus.io/) instance scraping the
   `/metrics` endpoint of the Stellar Tags server.
2. Grafana with the Prometheus datasource configured.

## Importing the Dashboard

1. Open Grafana and navigate to **Dashboards > Import**.
2. Click **Upload JSON file** and select `docs/grafana-dashboard.json`.
3. Select your Prometheus datasource when prompted.
4. Click **Import**.

The dashboard uid is `stellar-tags-db-pool` and can be accessed directly at
`/d/stellar-tags-db-pool`.

## Dashboard Panels

### Database Connection Pool

| Panel | Metric | Description |
| --- | --- | --- |
| Connection Pool State | `stellar_tags_db_pool_connections_{open,busy,idle}` | Time series showing open, busy, and idle connections over time. Yellow threshold at 15, red at 20. |
| Queries Waiting for Connection | `stellar_tags_db_pool_queries_waiting` | Queries queued because all pooled connections are busy. Yellow at 5, red at 20. |
| Pool Open / Busy / Waiting (stat) | Same as above | Current values as single-stat panels for at-a-glance status. |
| Redis Status | `stellar_tags_redis_connections_active` | `1` when Redis is connected, `0` otherwise. |

### HTTP Requests

| Panel | Metric | Description |
| --- | --- | --- |
| Request Rate by Status | `stellar_tags_http_requests_total` | Requests per second grouped by `status_code`. Stacked bars: green (2xx), blue (3xx), yellow (4xx), red (5xx). |
| Request Latency (p95 / p99) | `stellar_tags_http_request_duration_seconds` | Histogram quantiles per route. Yellow at 0.5s, red at 2s. |

### System Resources

| Panel | Metric | Description |
| --- | --- | --- |
| Memory Usage | `stellar_tags_process_resident_memory_bytes`, `stellar_tags_nodejs_heap_size_used_bytes` | Resident memory and V8 heap usage. |
| CPU Usage | `stellar_tags_process_cpu_user_seconds_total`, `stellar_tags_process_cpu_system_seconds_total` | User and system CPU time as a rate. |

## Template Variables

| Variable | Description |
| --- | --- |
| `datasource` | Prometheus datasource selector. |
| `instance` | Filters by scrape target instance (multi-select, defaults to All). |

## Alerting Suggestions

Create Grafana alerts on the following to catch pool exhaustion early:

- **Connection Pool Exhaustion**: Alert when
  `stellar_tags_db_pool_connections_busy / stellar_tags_db_pool_connections_open > 0.8`
  for 5 minutes.
- **Queued Queries**: Alert when `stellar_tags_db_pool_queries_waiting > 0`
  for 2 minutes.
- **Redis Down**: Alert when `stellar_tags_redis_connections_active == 0` for
  1 minute.

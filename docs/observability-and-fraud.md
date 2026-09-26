# Payment observability and fraud detection

## Tracing

The API starts OpenTelemetry before Express is loaded. HTTP, Express, and
Prisma spans are exported to Zipkin (or another Zipkin-compatible collector)
using `OTEL_EXPORTER_ZIPKIN_ENDPOINT`. Set `OTEL_SERVICE_NAME` per deployment.

Each request receives an `X-Correlation-ID` and, when a span is active, an
`X-Trace-ID` response header. The structured request log contains both values.
This makes a payment trace searchable across the API and the listener.

## Fraud stream

The Horizon listener publishes payment events to the Redis stream configured by
`PAYMENT_STREAM` (default: `payments`). The `fraud-worker` service consumes the
stream as the `FRAUD_CONSUMER_GROUP` consumer group, scores amount magnitude and
per-sender burst velocity, and stores high-risk decisions in `fraud_alerts`.

Flagged payments also update the matching payment row with `fraud_status`,
`risk_score`, and `fraud_flagged_at`. Registered webhooks subscribed to
`fraud.detected` receive the signed, retryable compliance notification.

Run locally with:

```sh
docker compose --profile dev up --build
```

Tune the alert threshold with `FRAUD_HIGH_RISK_THRESHOLD` (default `0.8`).

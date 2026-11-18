<!-- cspell:words RABBITMQ -->

# Transactional payment outbox (#929)

The persistent outbox in `src/services/settlementOutbox.js` is **not** the
in-memory sharded settlement `OutboxEngine`. `createPaymentWithOutbox` and
`updatePaymentWithOutbox` save the payment and notification in **one** Prisma
transaction; the event-sourced command path does the same for `PaymentEvent`.
No broker publication occurs in a database transaction. If an outbox insert
fails, the payment change is rolled back; if a broker is down, the committed
outbox message remains retryable.

## Deploy

1. Run `npm run prisma:generate && npm run prisma:deploy` before starting
   application or worker processes.
2. Enable RabbitMQ's management plugin. Create a **durable** exchange named
   `payment.events` (for example `topic`) and bind at least one **durable**
   queue to routing key `payments`. Configure a persistent consumer that uses
   the message's `id` / RabbitMQ `message_id` for deduplication.
3. Set `RABBITMQ_MANAGEMENT_URL` (e.g. `http://localhost:15672`),
   `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, and optionally `RABBITMQ_VHOST`,
   `RABBITMQ_EXCHANGE`, `RABBITMQ_ROUTING_KEY`, `OUTBOX_POLL_INTERVAL_MS`.
   Prefer HTTPS for remote management API endpoints.
4. Run **a separate long-lived process**: `node settlement-outbox-worker.js`.
   It requires a working `DATABASE_URL` and should be restarted automatically
   by the service manager or orchestrator.
5. Monitor `outbox_messages` for `FAILED` or stale `locked_until` rows and
   alert on persistent delivery lag. Failed deliveries have exponential retry
   delays capped at 60 seconds; retry attempts are never silently discarded.

## Delivery contract

Messages are published to RabbitMQ's **HTTP management exchange publish API**
with `delivery_mode: 2` and `message_id` equal to the PostgreSQL outbox id.
HTTP errors, timeouts and `routed: false` leave rows retryable. Worker claims
use conditional PostgreSQL updates and expiring leases to prevent normal
concurrent duplicates. At-least-once delivery means duplicates remain possible
if a worker crashes after publication but before marking the row PROCESSED.
Consumers **must** deduplicate by stable message id. The management API
returns route status, not AMQP publisher confirms; if stronger persistence
acknowledgements are required, replace the injected publisher with an AMQP
confirm-channel transport.

## Tests

- `npm test -- tests/settlement-transactional-outbox.test.js`
- `npm run test:integration -- --runTestsByPath tests/containers/settlement-transactional-outbox.test.js`

The integration test uses a real PostgreSQL container. It simulates an
unavailable broker, verifies the message remains in PostgreSQL, then restores
publication and checks it is eventually processed. It also checks rollback
when the outbox insert fails inside the payment transaction.

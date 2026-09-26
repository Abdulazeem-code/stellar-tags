# Webhook queue (RabbitMQ)

The webhook delivery pipeline is backed by RabbitMQ instead of Redis/BullMQ.
Publishers and consumers live in `src/queue/rabbitmqQueue.js` and are wired
into `src/webhookWorker.js`.

## Topology

| Object | Type | Purpose |
| --- | --- | --- |
| `stellar.webhooks` | topic exchange (durable) | Publish point; routing keys are `webhook.<event>` (e.g. `webhook.payment.received`). |
| `webhook-deliveries` | queue (durable) | Work queue, bound to the exchange with `webhook.#`. Dead-letters to `stellar.webhooks.dlx`. |
| `webhook-deliveries.retry` | queue (durable) | Holds a failed delivery for its per-message TTL, then dead-letters it back to the exchange for redelivery. |
| `webhook-deliveries.dlq` | queue (durable) | Terminal dead-letter queue for deliveries that exhausted all attempts. |
| `stellar.webhooks.dlx` | fanout exchange (durable) | Routes permanently-failed deliveries to the DLQ. |

## Delivery guarantees

* Messages are published `persistent` onto durable queues, so a broker restart
  does not lose in-flight deliveries.
* The producer uses a confirm channel and awaits `waitForConfirms()` before an
  enqueue is treated as successful.
* A failed delivery is republished to the retry queue with an exponential
  backoff TTL (base = the job's `backoff.delay`, capped at 60s) and re-delivered
  by the work queue when the TTL expires.
* After `attempts` (default 5) the message is `nack`-ed without requeue, so it
  flows through the dead-letter exchange into the DLQ.

## Configuration

```
RABBITMQ_URL="amqp://guest:guest@localhost:5672"
```

`docker compose --profile dev up` starts a RabbitMQ broker (AMQP on 5672,
management UI on 15672) alongside the API, Postgres and Redis. Redis remains in
the stack for caching and rate limiting.

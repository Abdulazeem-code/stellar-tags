# API reference

Every public and admin endpoint of the `stellar-payment-platform` server, its error contract, request validation and metrics.

> Back to the [README](../README.md).

## Error responses

Every API error leaves the server in one shape, produced by a single terminal
handler (`stellar-payment-platform/src/middleware/errorHandler.js`):

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Invalid request body",
    "details": [{ "field": "username", "message": "username is required" }]
  },
  "correlation_id": "3f2a…",
  "reference_id": "9b41…"
}
```

`error.code` is the stable part of the contract — branch on it rather than on
the status or the message text, which may be reworded. `details` appears only
when the failure is field-level. `correlation_id` is on every error;
`reference_id` is added on `5xx` and matches the logged stack.

| Code | Status | Raised when |
| --- | --- | --- |
| `INVALID_INPUT` | 400 | Malformed query, JSON, or a rejected value |
| `UNAUTHENTICATED` | 401 | Missing or failed signature verification |
| `FORBIDDEN` | 403 | Reserved name, blocked address |
| `NOT_FOUND` | 404 | No such tag, address, or route |
| `METHOD_NOT_ALLOWED` | 405 | Wrong verb on a known path |
| `CONFLICT` | 409 | Username already taken, or an address is at its 5-username limit |
| `PAYLOAD_TOO_LARGE` | 413 | Body over the 10kb cap |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Non-JSON body on a JSON endpoint |
| `VALIDATION_FAILED` | 422 | Body failed its schema |
| `RATE_LIMITED` | 429 | Rate limit exhausted |
| `INTERNAL_ERROR` | 500 | Unhandled failure |
| `UPSTREAM_ERROR` | 502 | Horizon or another upstream failed |
| `SERVICE_UNAVAILABLE` | 503 | Database or Redis unreachable, request timeout |

To raise one, throw or pass an `ApiError` — the handler is the only place that
turns an error into a response:

```js
const { ApiError } = require('./src/errors');

return next(new ApiError('CONFLICT', 'Username is already taken. Please choose another.'));
```

A `5xx` from an unexpected throw always reports the generic message so
internals are never leaked; the real error goes to the log under
`reference_id`. A message passed deliberately to `ApiError` is sent as written.

`GET /health` is exempt: it reports component status (`{ status, database,
redis, horizon }`) rather than an API error.

## Request validation

Incoming request bodies and query strings are validated by
[zod](https://zod.dev) schemas before any route handler runs. Schemas live in
`stellar-payment-platform/src/schemas/index.js`, and
`src/middleware/validateSchema.js` turns them into route middleware:

```js
const { validateSchema } = require('./src/middleware/validateSchema');
const { registerBodySchema, usersQuerySchema } = require('./src/schemas');

app.post('/register', validateSchema({ body: registerBodySchema }), handler);
app.get('/users', validateSchema({ query: usersQuerySchema }), handler);
```

The validated part is replaced with the parsed result, so handlers receive
values that are already trimmed and coerced — `req.query.limit` is a number,
not a string — and never re-check types themselves.

Failures short-circuit before the handler and respond with the field-level
errors, using the status that matches where the bad input came from:

| Failure | Status | Body |
| --- | --- | --- |
| Invalid `req.body` | `422 Unprocessable Entity` | `{ success: false, errors: [{ field, message }] }` |
| Invalid `req.query` | `400 Bad Request` | `{ success: false, errors: [{ field, message }] }` |

Two rules are deliberately *not* in the schemas, because the handlers own them
and answer `400` with their own domain-specific messages: Stellar address
format (checked with `StrKey`) and memo pairing/format (checked with
`validateMemo`). `page` and `limit` clamp to their bounds rather than being
rejected, so `?limit=1000` still returns the maximum page size.

## Detailed Endpoint Documentation

The Node.js server (`stellar-payment-platform/server.js`) exposes the following endpoints for username and payment lookups:

### `GET /federation`
Resolves a given username tag to a Stellar address.
- **Query Parameter:** `q` (string) - The username tag to lookup (e.g., `alice*localhost`).
- **Returns:** A JSON object with `stellar_address`, `account_id`, `memo_type`, and `memo`.
- **Status Codes:**
  - `200 OK`: Address found.
  - `400 Bad Request`: Missing `q` parameter.
  - `404 Not Found`: Name tag not found.
  - `500 Internal Server Error`: Database lookup failed.

### `POST /register`
Registers a new username and associates it with a Stellar address. An address
may hold up to 5 usernames (aliases), e.g. `payments*domain` and
`support*domain` for one business account. The first username registered for an
address is its primary; reverse (`type=id`) federation lookups resolve to it.
- **Body Parameters (JSON):** 
  - `username` (string) - The desired username.
  - `address` (string) - The user's Stellar address.
- **Returns:** A JSON object with registration details `{ ok: true, username, address, is_primary }`.
- **Status Codes:**
  - `200 OK`: Registration successful.
  - `400 Bad Request`: Missing `username` or `address`.
  - `409 Conflict`: Username already taken, or the address already has the maximum of 5 usernames.
  - `500 Internal Server Error`: Database lookup or insertion failed.

### `GET /lookup`
Resolves a given Stellar address to its registered username. When an address has
several usernames, the primary one is returned.
- **Query Parameter:** `address` (string) - The Stellar address to lookup.
- **Returns:** A JSON object with `username` and `address`.
- **Status Codes:**
  - `200 OK`: Username found.
  - `400 Bad Request`: Missing `address` parameter.
  - `404 Not Found`: Username not found for this address.
  - `500 Internal Server Error`: Database lookup failed.

### `GET /users/:username/activity`
Returns the caller's own activity trail: registrations, transfers,
unregistrations, webhook creation and deletion, and blocks applied to their
address.

Ownership is proven the same way the webhook endpoints prove it. Sign the
message `activity:<username>` with the account key and send the base64
signature:

```bash
curl "http://localhost:5000/users/ada*localhost/activity?limit=20" \
  -H "X-Stellar-Signature: <base64 signature>" \
  -H "X-Stellar-Signer: <G... public key>"
```

The signature may also be sent in the request body as `signature` /
`signerAddress`, matching `GET /webhooks`.

- **Query Parameters:**
  - `page` (optional) - 1-based page number, default 1.
  - `limit` (optional) - rows per page, default 10, capped at 100.
  - `startDate` / `endDate` (optional) - inclusive bounds on `created_at`.
- **Returns:** `{ data, meta: { total, page, limit, totalPages } }`, newest
  first. Each row carries `id`, `action`, `metadata`, `ip_address` and
  `created_at`.
- **Status Codes:**
  - `200 OK`: Trail returned.
  - `400 Bad Request`: Missing signature, or an unparseable/inverted date range.
  - `401 Unauthorized`: The signature does not belong to the account behind the
    username.
  - `404 Not Found`: Username not registered.

Actions are namespaced: `user.registered`, `user.unregistered`,
`user.transferred`, `user.blocked`, `webhook.created`, `webhook.deleted`. Rows
are removed with the user, so a purge does not leave a trail behind.

### `GET /health`
Aggregates the status of every external dependency: PostgreSQL (a `SELECT 1`
through Prisma), Redis (`PING`) and Stellar Horizon (an HTTP request to
`HORIZON_BASE`). The three probes run in parallel.
- **Returns:** `{ status, timestamp, database, redis, horizon }`, where each
  dependency is `up`, `down`, or `not configured` (Redis, when `REDIS_URL` is
  unset). A `DOWN` response also carries a `message` naming the failures.
- **Status Codes:**
  - `200 OK`: Every configured dependency responded.
  - `503 Service Unavailable`: At least one dependency is down.

`HEALTH_HORIZON_TIMEOUT_MS` (default 3000) bounds the Horizon probe so a
hanging Horizon cannot hold the response open.

### `GET /transactions/export`
Streams the account's payment history as a CSV download.
- **Query Parameters:** `address` (required) - Stellar public key. `order` (optional) - `desc` (default) or `asc`.
- **Returns:** `text/csv` with a `Content-Disposition` attachment header. Columns: `id`, `created_at`, `type`, `from`, `to`, `amount`, `asset_type`, `asset_code`, `asset_issuer`, `transaction_hash`.
- **Status Codes:**
  - `200 OK`: Stream started. Sent chunked, so there is no `Content-Length`.
  - `400 Bad Request`: Missing or invalid `address`.
  - `404 Not Found`: Account not found on Horizon.
  - `502 Bad Gateway`: Horizon request failed.

Pages of 200 records are fetched from Horizon with its cursor, converted, and
flushed as they arrive, so neither the full result set nor the full CSV is held
in memory: heap use plateaus around 18MB whether the export is 5,000 rows or
100,000. Writes respect socket backpressure, and `EXPORT_MAX_PAGES`
(default 500) bounds a single export — a truncated export is logged as a
warning. Because the response is committed once streaming starts, a mid-stream
failure can only be logged and the connection cut, since the JSON error
envelope needs unsent headers.

The `/payments` collection mixes operation types that name the same concepts
differently, so participant and amount columns are normalised per type: a
`create_account` reports `funder`/`account`/`starting_balance` and an
`account_merge` reports `account`/`into`.

### `GET /admin/export`
Streams transaction records from the database as a CSV or NDJSON download for external accounting.
- **Query Parameters:**
  - `format` (optional) – `csv` (default) or `json`.
  - `startDate` (optional) – `YYYY-MM-DD` inclusive lower bound on `createdAt`.
  - `endDate` (optional) – `YYYY-MM-DD` inclusive upper bound on `createdAt`.
- **Headers:** `x-api-key` (required) – must match `ADMIN_API_KEY`.
- **Returns:** `text/csv` or `application/x-ndjson` with a `Content-Disposition: attachment` header.
- **Status Codes:**
  - `200 OK`: Stream started.
  - `400 Bad Request`: Invalid date format or `startDate` after `endDate`.
  - `401 Unauthorized`: Missing or invalid API key.

Records are fetched 500 at a time and written directly to the response, so heap use stays bounded regardless of export size. JSON output is newline-delimited (one object per line) for easy streaming parsing.

### `GET /admin/stats/routing`
Returns historical payment routing statistics and aggregated volumes, fees, and transaction counts grouped by day, week, or month.
- **Query Parameters:**
  - `startDate` (optional) – `YYYY-MM-DD` inclusive lower bound on `createdAt`.
  - `endDate` (optional) – `YYYY-MM-DD` inclusive upper bound on `createdAt`.
  - `groupBy` (optional) – `'day'` (default), `'week'`, or `'month'`.
  - `interval` (optional) – Alias for `groupBy`.
  - `assetCode` (optional) – Filter transactions by asset code (e.g., `XLM`, `USDC`).
- **Headers:** `x-api-key` (required) – must match `ADMIN_API_KEY` (or pass `api_key` in query params).
- **Returns:** JSON object containing `interval`, `startDate`, `endDate`, `summary` (`total_volume`, `total_fees`, `total_count`), and `data` array of periodic records (`[{ period, volume, fees, count }]`).
- **Status Codes:**
  - `200 OK`: Statistics retrieved successfully.
  - `400 Bad Request`: Invalid date format, `startDate` after `endDate`, or invalid `groupBy`.
  - `401 Unauthorized`: Missing or invalid API key.

### `GET /admin/audit-logs`
Retrieves recent immutable audit trail records for mutating admin actions (`POST`, `PUT`, `DELETE`, `PATCH`).
- **Query Parameters:**
  - `limit` (optional) – Maximum number of records to return (1-100, default 50).
- **Headers:** `x-api-key` (required) – must match `ADMIN_API_KEY` (or pass `api_key` in query params).
- **Returns:** JSON object with `success: true`, `count`, and `data` array of audit records containing `action`, `method`, `path`, `userId`, `ipAddress`, `userAgent`, `statusCode`, `payload` (sensitive data redacted), and `createdAt`.
- **Status Codes:**
  - `200 OK`: Audit logs retrieved successfully.
  - `401 Unauthorized`: Missing or invalid API key.

Mutating admin requests are intercepted by `auditLogMiddleware` and recorded asynchronously upon response completion. Sensitive keys (`password`, `secret`, `apiKey`, `token`, `signature`, `privateKey`, `seed`) are deeply redacted before persistence.

### `GET /admin/webhooks/health`
Aggregates webhook delivery health so operators can spot broken merchant integrations.
- **Query Parameters:**
  - `username` (optional) – Scope the aggregates to one merchant's webhooks.
- **Headers:** `x-api-key` (required) – must match `ADMIN_API_KEY`.
- **Returns:** JSON object with `success: true`, a `summary` (`total`, `healthy`, `failing`, `successRate24h`), and `failingOver24h` — the webhooks that have been failing continuously for more than 24 hours.
- **Status Codes:**
  - `200 OK`: Health snapshot retrieved successfully.
  - `401 Unauthorized`: Missing or invalid API key.

A webhook is "failing" while its `failingSince` timestamp is set (cleared on the next successful delivery). `successRate24h` is the share of webhooks with a delivery attempt in the last 24h that are currently healthy; it is `null` when nothing has been active in that window.

### Dead letter queue: `/admin/dlq`

Webhook deliveries that exhaust `MAX_RETRY_ATTEMPTS` are parked on the
`payment-retries-dlq` BullMQ queue instead of being retried forever, so they can
be inspected and replayed by hand. Parked jobs keep their original payload,
attempt count, failure reason, and a truncated stack trace, and are never retried
or removed on their own.

The dead letter queue needs Redis. With neither `REDIS_URL` nor
`REDIS_CLUSTER_NODES` set, the worker logs a warning and falls back to the legacy
database-backed dead letter handling; `GET /admin/dlq` then reports
`available: false` with an empty list, and the per-message endpoints below return
`503`.

All endpoints below require `x-api-key` matching `ADMIN_API_KEY`. The mutating
ones (`POST`, `DELETE`) additionally require an `Idempotency-Key` header, as with
every other mutating `/api/v1` request, so a retried or double-clicked call
cannot replay a message twice. Webhook secrets are redacted from every payload
before it is returned.

| Endpoint | Purpose |
| --- | --- |
| `GET /admin/dlq` | List parked messages |
| `GET /admin/dlq/:id` | Read one message |
| `POST /admin/dlq/:id/replay` | Replay one message |
| `POST /admin/dlq/replay` | Replay a batch |
| `DELETE /admin/dlq/:id` | Discard one message |

**`GET /admin/dlq`**
- **Query Parameters:** `limit` (optional, 1-100, default `20`), `page` (optional, default `1`), `username` (optional) to scope the listing to one merchant. A non-numeric `limit` or `page` falls back to the default rather than failing.
- **Returns:** `success: true`, `available`, `messages`, and `meta` (`total`, `page`, `limit`, `totalPages`). `total` always describes the same set as `messages`: unfiltered, BullMQ counts the queue directly; filtered, the queue is walked in full so the page and the count stay consistent.
- **Status Codes:** `200 OK`, `401 Unauthorized`.

**`GET /admin/dlq/:id`**
- **Returns:** `success: true` and the `message`, with `failureReason`, `stack`, `attemptsMade`, and the redacted `payload`.
- **Status Codes:** `200 OK`, `401 Unauthorized`, `404 Not Found`, `503 Service Unavailable` (no Redis).

**`POST /admin/dlq/:id/replay`**
- **Headers:** `x-api-key`, `Idempotency-Key`.
- **Returns:** `success: true`, `replayed: true`, `replayedJobId`, and the `queue` the job went back to. The attempt budget is reset, so a replayed job gets a fresh set of retries.
- **Status Codes:** `200 OK`, `401 Unauthorized`, `404 Not Found`, `503 Service Unavailable`.

**`POST /admin/dlq/replay`**
- **Headers:** `x-api-key`, `Idempotency-Key`.
- **Body (optional):** `limit` (capped at `DLQ_REPLAY_BATCH_LIMIT`) and `username` to narrow the batch. An empty body replays the whole queue up to that cap.
- **Returns:** `success: true`, counts of `replayed` and `failed`, a `failed` array of `{ id, error }` for messages that could not be replayed, and `capped` when the queue held more messages than the batch limit allowed. Per-message failures are reported without failing the whole batch.
- **Status Codes:** `200 OK`, `401 Unauthorized`, `503 Service Unavailable`.

**`DELETE /admin/dlq/:id`**
- **Headers:** `x-api-key`, `Idempotency-Key`.
- **Returns:** `success: true`, `id`, `discarded: true`. The message is dropped without being replayed, which is permanent.
- **Status Codes:** `200 OK`, `401 Unauthorized`, `404 Not Found`, `503 Service Unavailable`.

### `GET /payments/:paymentId/events`

Server-Sent Events stream of payment status updates (#730). The flow is
strictly one-way (server → client), so clients use the browser's `EventSource`
and reconnection is handled natively — no custom retry logic, and the server
advertises its preferred reconnect delay with a `retry:` hint.
- **Path Parameter:** `paymentId` (string, 1-128 chars of `[A-Za-z0-9_-]`) -
  payment, payment-intent or payment-request id (#1046).
- **Returns:** a `text/event-stream` response that stays open until the client
  disconnects, emitting:
  - `connected` - `{ paymentId }`, sent as soon as the stream opens.
  - `snapshot` - `{ paymentId, status, transactionHash? }`, the last known
    status, so a client that just (re)connected converges immediately instead
    of waiting for the next transition. For a payment request the snapshot is
    `{ paymentId, status, transactionHash?, paidAt?, expiresAt?,
    type: "payment_request" }`; a pending request past its `expiresAt` reports
    `status: "expired"`.
  - `payment-update` - `{ paymentId, status, ... }` on every status change.
    Publishers (e.g. the Horizon listener) push these to Redis, so every API
    node fans them out to its own connected streams. Payment request updates
    carry `type: "payment_request"` and are published when the matcher marks a
    request `paid` or the request is cancelled/expired.
- **Alias:** `GET /payment-requests/:id/events` serves the same stream for a
  payment request id.
- **Client usage:** open `new EventSource(url)` with
  `url = "${API_BASE}/api/payments/<id>/events"`; a ready-made wrapper
  (handlers + teardown) lives in `payment-dashboard/src/lib/paymentEvents.js`.
- **Status Codes:** `200 OK`, `400 Bad Request` (invalid `paymentId`),
  `429 Too Many Requests` (per-IP stream budget).

### `GET /metrics`

Prometheus scrape endpoint, served in the Prometheus text format. Exempt from the
rate limiter so a scraper on a fixed interval is never throttled.
- **Returns:** all metrics below, prefixed `stellar_tags_`.
- **Status Codes:** `200 OK`.

| Metric | Type | Description |
| --- | --- | --- |
| `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, ... | gauge | Memory usage |
| `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total` | counter | CPU usage |
| `http_requests_total` | counter | Requests by `method`, `route`, `status_code` |
| `http_request_duration_seconds` | histogram | Request latency by `method`, `route`, `status_code`; buckets at 10ms, 50ms, 100ms, 500ms, 1s, 5s |
| `db_pool_connections_open` | gauge | Connections open in the Prisma pool |
| `db_pool_connections_busy` | gauge | Connections executing a query |
| `db_pool_connections_idle` | gauge | Connections open but unused |
| `db_pool_queries_waiting` | gauge | Queries queued waiting for a connection |
| `redis_connections_active` | gauge | `1` while Redis is ready for commands, else `0` |
| `stellar_tags_dlq_depth` | gauge | Messages currently parked on `payment-retries-dlq`; reads `0` when Redis is unavailable |
| `stellar_tags_dlq_messages_total` | counter | Messages ever routed to the dead letter queue |

Memory and CPU come from `prom-client`'s default collectors. The pool gauges read
Prisma's `$metrics` (which requires the `metrics` preview feature in
`schema.prisma`) and report `0` when it is unavailable. The dead letter queue
depth is read at scrape time, so a restart does not reset it and no work happens
unless something asks for the value.

`monitoring/prometheus-dlq-alerts.yml` contains ready-to-load rules that fire when
the backlog grows past `DLQ_ALERT_THRESHOLD`, and when it keeps rising for 15
minutes.


## Payment requests

A payment request is a one-off invoice for a tag: a fixed amount and asset, a
unique memo, and an expiry. The Horizon listener watches the tag's account and
marks the request `paid` when a payment arrives with the request's memo, the
same asset, and at least the requested amount. Walkthrough:
[payment-requests.md](payment-requests.md).

All paths are served under `/api/v1` (and the `/api` alias).

**Statuses:** `pending` → `paid` | `expired` | `cancelled`. A pending request
past its `expiresAt` is reported as `expired` on every read, even before the
expiry sweep stores it.

**Request object** (returned as `data` by every endpoint below):

```json
{
  "id": "2c80a413-18d7-5a51-990e-449b21996106",
  "tag": "alice*stellartags.xyz",
  "destination": "GD...",
  "amount": "25",
  "asset": "XLM",
  "memoType": "text",
  "memo": "invoice-42",
  "description": "Order #42",
  "status": "pending",
  "expiresAt": "2026-11-25T12:00:00.000Z",
  "paidAt": null,
  "transactionHash": null,
  "createdAt": "2026-11-24T12:00:00.000Z"
}
```

**Signing.** Creating and cancelling a request prove ownership of the tag.
Sign the text `payment-request:<tag>` (for example
`payment-request:alice*stellartags.xyz`, the full lower-case tag) with the
tag's Stellar account key as a Freighter-style signed message (SEP-53:
ed25519 over `sha256("Stellar Signed Message:\n" + message)`), base64-encode
it, and send it as `X-Stellar-Signature`, with the account address in
`X-Stellar-Signer`. Freighter's `signMessage` produces this directly; from
Node.js:

```js
const crypto = require('crypto');
const { Keypair } = require('@stellar/stellar-sdk');

const keypair = Keypair.fromSecret(process.env.STELLAR_SECRET);
const message = 'payment-request:alice*stellartags.xyz';
const hash = crypto.createHash('sha256')
  .update(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(message)]))
  .digest();
console.log(keypair.sign(hash).toString('base64')); // X-Stellar-Signature
console.log(keypair.publicKey());                   // X-Stellar-Signer
```

The same signature works for every create and cancel on that tag.

### `POST /payment-requests`
Creates a pending payment request.
- **Headers:**
  - `Content-Type: application/json` (required)
  - `Idempotency-Key` (required) - Any unique string up to 128 characters. A
    retry with the same key and body returns the first response.
  - `X-Stellar-Signature` (required) - See *Signing* above. `signature` in the
    body is also accepted.
  - `X-Stellar-Signer` - The signing address. `signerAddress` in the body is
    also accepted.
- **Body Parameters (JSON):**
  - `tag` (string, required) - The tag to be paid. A bare name (`alice`) is
    completed with the server's domain.
  - `amount` (string or number, required) - Positive decimal, at most 7
    decimal places.
  - `asset` (string, optional) - `XLM` (default, `native` is an alias) or
    `CODE:ISSUER`.
  - `memo` (string, optional, max 28) - Your own reference. Must be unique
    across all payment requests. When omitted, a random 20-character text
    memo is generated.
  - `memoType` (string, optional) - `text` (default), `id` or `hash`.
    `memo_type` is also accepted.
  - `description` (string, optional, max 140) - Shown to the payer. HTML is
    stripped and profanity is rejected.
  - `expiresAt` (ISO 8601 string, optional) - Defaults to 24 hours from now,
    at most 30 days ahead. `expires_at` is also accepted.
- **Returns:** `201` with `{ ok: true, data: <request>, link, sep7 }`, where
  `link` is the HTTPS pay link
  (`https://<host>/pay/<name>?amount=…&memo=…&memoType=…&requestId=…`) and
  `sep7` is a `web+stellar:pay?destination=…&amount=…&memo=…` URI for wallets.
- **Status Codes:**
  - `201 Created`: Request created.
  - `400 Bad Request`: Missing or invalid `Idempotency-Key`, or bad signer address.
  - `401 Unauthorized`: Missing signature, or the signature does not verify.
  - `404 Not Found`: Tag not found.
  - `409 Conflict`: The supplied `memo` is already used, or the same
    `Idempotency-Key` is in flight.
  - `415 Unsupported Media Type`: Body is not JSON.
  - `422 Unprocessable Entity`: Invalid amount, asset, memo, description or
    `expiresAt` (`VALIDATION_FAILED`).
  - `429 Too Many Requests`: Rate limit exceeded.

```bash
curl -X POST http://localhost:5000/api/v1/payment-requests \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "X-Stellar-Signature: $SIGNATURE" \
  -H "X-Stellar-Signer: $ADDRESS" \
  -d '{"tag":"alice","amount":"25","asset":"XLM","memo":"invoice-42","description":"Order #42"}'
```

### `GET /payment-requests/:id`
Returns one payment request. Public: anyone with the id can read it.
- **Path Parameter:** `id` (string) - The request id.
- **Returns:** `{ ok: true, data: <request> }`.
- **Status Codes:**
  - `200 OK`: Found.
  - `404 Not Found`: Unknown id.
  - `429 Too Many Requests`: Rate limit exceeded.

```bash
curl http://localhost:5000/api/v1/payment-requests/$REQUEST_ID
```

### `POST /payment-requests/:id/cancel`
Cancels a pending request. Payments that arrive later with its memo are
ignored. Sends the `payment_request.cancelled` webhook.
- **Path Parameter:** `id` (string) - The request id.
- **Headers:** `X-Stellar-Signature` (required) and `X-Stellar-Signer`, signed
  for the request's tag. `signature` / `signerAddress` in a JSON body are also
  accepted.
- **Returns:** `{ ok: true, data: <request> }` with `status: "cancelled"`.
- **Status Codes:**
  - `200 OK`: Cancelled.
  - `400 Bad Request`: Bad signer address.
  - `401 Unauthorized`: Missing signature, or the signature does not verify.
  - `404 Not Found`: Unknown id, or the tag no longer exists.
  - `409 Conflict`: The request is already `paid`, `expired` or `cancelled`.
  - `429 Too Many Requests`: Rate limit exceeded.

```bash
curl -X POST http://localhost:5000/api/v1/payment-requests/$REQUEST_ID/cancel \
  -H "X-Stellar-Signature: $SIGNATURE" \
  -H "X-Stellar-Signer: $ADDRESS"
```

### `GET /payment-requests/:id/qr.png` and `GET /payment-requests/:id/qr.svg`
Returns a QR code for the request, ready for an `<img>` tag.
- **Path Parameter:** `id` (string) - The request id.
- **Query Parameters:**
  - `size` (integer, optional) - Width in pixels, `128` to `1024`, default
    `512`. Values outside the range are clamped; non-numbers use the default.
  - `format` (string, optional) - `link` (default, the HTTPS pay link) or
    `sep7` (the `web+stellar:pay` URI, for wallets that scan directly).
- **Returns:** `image/png` or `image/svg+xml`. Error correction level `M`.
  `Cache-Control: public, max-age=300` while the request is pending,
  `no-store` once it is paid, expired or cancelled.
- **Status Codes:**
  - `200 OK`: Image returned.
  - `400 Bad Request`: `format` is not `link` or `sep7`.
  - `404 Not Found`: Unknown id.
  - `429 Too Many Requests`: Rate limit exceeded.

```bash
curl -o invoice.png "http://localhost:5000/api/v1/payment-requests/$REQUEST_ID/qr.png?size=256&format=sep7"
```

### `GET /payment-requests/:id/events`
Server-Sent Events stream for one request; an alias of
[`GET /payments/:paymentId/events`](#get-paymentspaymentidevents). It sends a
`snapshot` with the current status on connect and a `payment-update`
(`type: "payment_request"`) when the request is paid, cancelled or expires.
- **Status Codes:** `200 OK`, `400 Bad Request` (invalid id),
  `429 Too Many Requests` (per-IP stream budget).

```bash
curl -N http://localhost:5000/api/v1/payment-requests/$REQUEST_ID/events
```

### Payment request webhooks
Webhooks registered for the tag (`POST /webhooks`) receive these events,
signed and retried exactly like `payment.received` (see
[webhook-signature-verification.md](webhook-signature-verification.md)):

| Event | Sent when |
|---|---|
| `payment_request.paid` | The request is matched to a payment. |
| `payment_request.expired` | The request passes `expiresAt` unpaid (checked every minute). |
| `payment_request.cancelled` | The owner cancels the request. |

```json
{
  "event": "payment_request.paid",
  "event_id": "2c80a413-18d7-5a51-990e-449b21996106-paid",
  "timestamp": "2026-11-24T12:00:00.000Z",
  "network": "testnet",
  "data": {
    "request_id": "2c80a413-18d7-5a51-990e-449b21996106",
    "tag": "alice*stellartags.xyz",
    "amount_requested": "25",
    "amount_paid": "25.0000000",
    "asset": "XLM",
    "memo": "invoice-42",
    "transaction_hash": "3389e9f0...",
    "paid_at": "2026-11-24T11:59:58.000Z"
  }
}
```

`event_id` is `<request_id>-<paid|expired|cancelled>` and does not change
between retries, so use it to de-duplicate. For `expired` and `cancelled`,
`amount_paid`, `transaction_hash` and `paid_at` are `null`.


## Webhook signature verification

Every webhook delivery includes an HMAC-SHA256 signature in the
`X-Webhook-Signature` header (and the backward-compatible alias
`X-Stellar-Tags-Signature`). Merchants must verify this signature before
trusting the payload.

See [docs/webhook-signature-verification.md](webhook-signature-verification.md)
for step-by-step verification examples in Node.js, Python, and Go.


## Webhook events

Webhooks are registered per tag and receive every event unless their `events`
list narrows it (use `*` for all). All events share the same envelope, queue,
retry policy (`MAX_RETRY_ATTEMPTS`, exponential backoff), HMAC signing and dead
letter queue.

| Event | When it is sent |
|---|---|
| `payment.received` | A payment lands on the tag's Stellar account. |
| `payment_request.paid` | A pending payment request is matched to a payment (memo, asset and amount). |
| `payment_request.expired` | A pending payment request passes its `expiresAt` (checked every minute). |
| `payment_request.cancelled` | The owner cancels a pending request with `POST /payment-requests/:id/cancel`. |

`payment_request.*` payload:

```json
{
  "event": "payment_request.paid",
  "event_id": "6f1c2d1e-...-paid",
  "timestamp": "2026-11-24T12:00:00.000Z",
  "network": "testnet",
  "data": {
    "request_id": "6f1c2d1e-...",
    "tag": "alice*stellartags.xyz",
    "amount_requested": "25",
    "amount_paid": "25.0000000",
    "asset": "XLM",
    "memo": "invoice-42",
    "transaction_hash": "3389e9f0...",
    "paid_at": "2026-11-24T11:59:58.000Z"
  }
}
```

- `event_id` is `<request_id>-<paid|expired|cancelled>`. It is the same on every
  retry, so use it to de-duplicate.
- `amount_paid` can be higher than `amount_requested` (overpayments still settle
  the request).
- For `payment_request.expired` and `payment_request.cancelled`, `amount_paid`,
  `transaction_hash` and `paid_at` are `null`.

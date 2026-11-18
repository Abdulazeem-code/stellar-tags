# Payment request retries

Send an `Idempotency-Key` with each payment creation request. Keep the same key
when retrying the same request. Use a new key for a different payment.

The backend reserves the key before running the handler. A simultaneous retry
receives HTTP 409 while the first request is processing. After a successful
response, an identical retry receives the saved response with
`X-Idempotent-Replay: true`. A key reused with a different request body, URL,
or caller credentials receives HTTP 409 and cannot see the first response.

Completed responses remain available for 24 hours. A request still processing
holds its reservation for at most five minutes. Failed responses release the
key so the caller can retry. If configured Redis is unavailable, requests with
an idempotency key receive HTTP 503 instead of running without protection.
Without Redis configuration, the backend uses a per-process memory cache for
local development; use Redis for deployments with more than one process.

Run `node scripts/benchmark-idempotency.js` from `stellar-payment-platform` to
compare 100 simultaneous requests with and without protection. The security
measure is handler executions: one with protection versus 100 without it.
This benchmark uses the local memory path. The Redis path is covered by the
container-backed integration test.

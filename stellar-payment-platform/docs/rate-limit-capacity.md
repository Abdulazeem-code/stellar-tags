# Rate limit capacity and Redis outages

The local rate limit store now keeps at most 10,000 client keys per limiter.
Expired keys are removed as new requests arrive. When the store is full and
all keys are active, a new client receives HTTP 429 until the oldest window
expires. An active client's count is never discarded to make room.

When Redis is configured, the signature verification limit uses its shared
counter across backend processes. If Redis fails, these expensive requests
receive HTTP 503 instead of switching to separate counters in each process.
Other rate limits keep their existing local fallback. If Redis is not
configured, the signature limit uses the bounded local store for development.

Run `node scripts/benchmark-rate-limit-store.js` from
`stellar-payment-platform` to compare retained keys after 50,000 distinct
clients. The previous store retains 50,000 keys. The bounded store retains
10,000 during the window and one after the window expires and another request
arrives. This measures storage growth, not HTTP throughput.

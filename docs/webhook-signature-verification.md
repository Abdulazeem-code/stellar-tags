# Webhook Signature Verification

Every webhook POST sent by Stellar Tags includes an HMAC-SHA256 signature so
merchants can confirm the request genuinely came from the platform and has not
been tampered with in transit.

## Headers

| Header | Description |
|---|---|
| `Stellar-Signature` | Hex-encoded HMAC-SHA256 of `timestamp + "." + raw JSON body`, signed with the webhook secret. The dispatch timestamp is cryptographically bound so the header cannot be swapped in transit. Prefer this for new integrations. |
| `Stellar-Timestamp` | ISO 8601 dispatch timestamp (same value as `payload.timestamp`). Must be within 5 minutes in the past and no more than 1 minute in the future. |
| `X-Webhook-Signature` | Legacy hex-encoded HMAC-SHA256 of the raw JSON body only. Kept for backward compatibility. |
| `X-Stellar-Tags-Signature` | Alias for `X-Webhook-Signature` — kept for backward compatibility. |
| `X-Webhook-Timestamp` | Legacy alias for `Stellar-Timestamp`. |

> Prefer `Stellar-Signature` / `Stellar-Timestamp` for new integrations.

## How the signature is computed

Legacy scheme (body only, still sent for backward compatibility):

```
HMAC-SHA256( key=<webhook_secret>, message=<raw JSON body> )
```

Timestamp-bound scheme (`Stellar-Signature`, required for replay protection):

```
HMAC-SHA256( key=<webhook_secret>, message=<timestamp> + "." + <raw JSON body> )
```

where `<timestamp>` is the exact value of the `Stellar-Timestamp` header
(ISO 8601, e.g. `2026-08-25T12:00:00.000Z`, identical to `payload.timestamp`).
`payload.timestamp` is part of the signed raw body, and additionally binding
the header timestamp means an attacker cannot strip or swap the header while
keeping a valid signature.

The raw JSON body is the exact byte sequence sent over the wire.
The webhook secret is the value you supplied when registering your webhook URL.

## Timestamp format and expiry

- `Stellar-Timestamp` is an **ISO 8601** string in UTC (same as `payload.timestamp`).
- Verifiers must reject dispatches whose timestamp is **older than 5 minutes
  (300 seconds)** — treat as `TIMESTAMP_EXPIRED`, possible replay attack.
- Verifiers must reject dispatches whose timestamp is **more than 1 minute
  (60 seconds) in the future** — treat as clock skew (`TIMESTAMP_TOO_FAR_IN_FUTURE`).
- Always check freshness **before** trusting the payload, and verify the
  `Stellar-Signature` against the received `Stellar-Timestamp` header value.

## Test verification endpoint

To validate a payload and signature before wiring up production code, send the
payload and the secret to `POST /api/v1/webhooks/verify-test` and include the
signature in the `X-Webhook-Signature` header. Because signatures are computed
over the raw body bytes, pass the payload as a JSON **string** exactly as it was
sent over the wire:

```bash
curl -X POST https://api.stellar-tags.example/api/v1/webhooks/verify-test \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Signature: <hex-signature>' \
  -d '{
    "secret": "your_webhook_secret",
    "payload": "{\"event\":\"payment.created\",\"id\":\"evt_123\",\"amount\":42}"
  }'
```

A successful response looks like:

```json
{
  "ok": true,
  "valid": true,
  "message": "Webhook signature verification succeeded.",
  "expectedSignature": "<hex-signature>",
  "receivedSignature": "<hex-signature>"
}
```

When the signature is wrong, the endpoint responds with `401` and a detailed
error payload including the expected and received values.

## Verifying in Node.js

```js
const crypto = require('crypto');

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes past
const FUTURE_SKEW_MS = 60 * 1000; // 1 minute future

/**
 * Verifies the timestamp-bound Stellar-Signature.
 *
 * @param {string} secret      - The webhook secret you registered.
 * @param {string} rawBody     - The raw request body (Buffer or string).
 * @param {string} timestamp   - Value of the Stellar-Timestamp header.
 * @param {string} sigHeader   - Value of the Stellar-Signature header.
 */
function verifyStellarSignature(secret, rawBody, timestamp, sigHeader) {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  // Constant-time comparison prevents timing-oracle attacks.
  if (expected.length !== sigHeader.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(sigHeader, 'hex'),
  );
}

function isFreshTimestamp(isoTimestamp, now = Date.now()) {
  const ts = Date.parse(isoTimestamp);
  if (Number.isNaN(ts)) return false;
  if (now - ts > TIMESTAMP_TOLERANCE_MS) return false; // older than 5 minutes
  if (ts - now > FUTURE_SKEW_MS) return false; // more than 1 minute in the future
  return true;
}

// Express example ─ use express.raw() to keep the body as a Buffer.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stellar-signature'];
  const timestamp = req.headers['stellar-timestamp'];
  if (!timestamp || !isFreshTimestamp(timestamp)) {
    return res.status(401).json({ error: 'Timestamp expired or invalid — possible replay attack' });
  }
  if (!sig || !verifyStellarSignature(process.env.WEBHOOK_SECRET, req.body, timestamp, sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = JSON.parse(req.body.toString());
  console.log('Verified webhook event:', payload.event);
  res.sendStatus(200);
});
```

Legacy `X-Webhook-Signature` verifiers keep working with a body-only HMAC
(`HMAC(secret, rawBody)`), but should still enforce the same 5-minute /
1-minute freshness window using `X-Webhook-Timestamp` or `payload.timestamp`.

## Verifying in Python

```python
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from flask import Flask, request, abort

app = Flask(__name__)
WEBHOOK_SECRET = b"your_webhook_secret"
TIMESTAMP_TOLERANCE_S = 5 * 60  # 5 minutes past
FUTURE_SKEW_S = 60  # 1 minute future

def is_fresh_timestamp(iso_timestamp):
    ts = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00")).timestamp()
    now = time.time()
    if now - ts > TIMESTAMP_TOLERANCE_S:
        return False
    if ts - now > FUTURE_SKEW_S:
        return False
    return True

@app.route("/webhook", methods=["POST"])
def webhook():
    raw_body = request.get_data()  # keep raw bytes before parsing
    timestamp = request.headers.get("Stellar-Timestamp", "")
    sig = request.headers.get("Stellar-Signature", "")

    if not timestamp or not is_fresh_timestamp(timestamp):
        abort(401, "Timestamp expired or invalid")

    expected = hmac.new(WEBHOOK_SECRET, f"{timestamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        abort(401, "Invalid signature")

    payload = json.loads(raw_body)
    print("Verified event:", payload["event"])
    return "", 200
```

## Verifying in Go

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "io"
    "net/http"
)

func verifyStellarSignature(secret, timestamp string, rawBody []byte, sigHeader string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(sigHeader))
}

func isFreshTimestamp(isoTimestamp string, now time.Time) bool {
	ts, err := time.Parse(time.RFC3339, isoTimestamp)
	if err != nil {
		return false
	}
	if now.Sub(ts) > 5*time.Minute {
		return false
	}
	if ts.Sub(now) > time.Minute {
		return false
	}
	return true
}

func webhookHandler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	timestamp := r.Header.Get("Stellar-Timestamp")
	sig := r.Header.Get("Stellar-Signature")

	if !isFreshTimestamp(timestamp, time.Now().UTC()) {
		http.Error(w, "Timestamp expired or invalid", http.StatusUnauthorized)
		return
	}
	if !verifyStellarSignature("your_webhook_secret", timestamp, body, sig) {
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}
	// process payload ...
	w.WriteHeader(http.StatusOK)
}
```

## Security recommendations

- **Always verify** the `Stellar-Signature` against the received
  `Stellar-Timestamp` header before trusting the payload.
- **Always enforce freshness**: reject timestamps older than 5 minutes or more
  than 1 minute in the future.
- Use **`timingSafeEqual`** (or `hmac.compare_digest` in Python, `hmac.Equal`
  in Go) — regular string equality is vulnerable to timing attacks.
- Rotate your webhook secret immediately if you suspect it has been leaked.

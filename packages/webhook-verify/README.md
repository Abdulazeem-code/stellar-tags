# @stellar-tags/webhook-verify

Dependency-free Node.js verification for Stellar Tags timestamp-bound webhook signatures. The package verifies the exact request bytes and parses the JSON only after authentication. It supports Node.js 18 and newer.

## Install

```sh
npm install @stellar-tags/webhook-verify
```

For the optional Express helper, install Express in your application:

```sh
npm install express
```

## Plain Node.js HTTP server

Collect the incoming body as bytes. Do not parse and re-serialize JSON before verification:

```js
import { createServer } from "node:http";
import { verifyWebhook } from "@stellar-tags/webhook-verify";

const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error("WEBHOOK_SECRET is required");

createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const result = verifyWebhook({
      rawBody: Buffer.concat(chunks),
      headers: request.headers,
      secret,
    });
    if (!result.valid) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: result.reason }));
      return;
    }
    console.log("Verified event:", result.payload.event);
    response.writeHead(200);
    response.end("ok");
  });
}).listen(3000);
```

## Express

Mount the verifier before any JSON body parser on this route. The helper uses `express.raw()` and leaves `req.body` as the original `Buffer`:

```js
import express from "express";
import { expressVerifier } from "@stellar-tags/webhook-verify";

const app = express();
const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error("WEBHOOK_SECRET is required");

app.post(
  "/webhooks/stellar-tags",
  expressVerifier({ secret }),
  (request, response) => {
    const payload = JSON.parse(request.body.toString("utf8"));
    console.log("Verified event:", payload.event);
    response.sendStatus(200);
  },
);
app.use(express.json());
app.listen(3000);
```

`expressVerifier` responds with HTTP 401 and the verification reason for invalid signatures. Body parser errors are passed to Express error handling.

## API

- `verifyWebhook({ rawBody, headers, secret, toleranceSeconds = 300, now?, allowLegacy? })` returns `{ valid: true, payload }` or `{ valid: false, reason }`. `rawBody` is a `Buffer` or string; `headers` is read case-insensitively. `now` is an optional `Date`, useful for deterministic verification.
- `expressVerifier({ secret, toleranceSeconds?, allowLegacy? })` returns Express middleware that captures the raw JSON request and continues only after successful verification.
- `allowLegacy` defaults to `false`. When `true`, it permits the body-only `X-Webhook-Signature` HMAC fallback. If a legacy timestamp header is supplied, its freshness is still checked.
- Failure reasons are `MISSING_HEADER`, `INVALID_SIGNATURE`, `TIMESTAMP_EXPIRED`, `TIMESTAMP_TOO_FAR_IN_FUTURE`, and `INVALID_PAYLOAD`.

The timestamp-bound signature is `HMAC-SHA256(secret, Stellar-Timestamp + "." + rawBody)`, represented as lowercase hexadecimal. Timestamps older than `toleranceSeconds` (300 seconds by default) or more than 60 seconds in the future are rejected. The received timestamp string and exact raw request body are used for signature calculation.

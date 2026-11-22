import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyWebhook } from "../dist/index.js";

const secret = "local-test-secret";
const now = new Date("2026-11-21T10:00:00.000Z");
const rawBody = Buffer.from('{"event":"payment.received","id":"evt_123"}');
const timestamp = now.toISOString();

function signature(message) {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function signedHeaders(body = rawBody, signedAt = timestamp, signingSecret = secret) {
  return {
    "Stellar-Timestamp": signedAt,
    "Stellar-Signature": createHmac("sha256", signingSecret)
      .update(Buffer.concat([Buffer.from(`${signedAt}.`), body]))
      .digest("hex"),
  };
}

test("accepts a timestamp-bound signature over the raw body", () => {
  const result = verifyWebhook({
    rawBody,
    headers: signedHeaders(),
    secret,
    now,
  });
  assert.deepEqual(result, {
    valid: true,
    payload: { event: "payment.received", id: "evt_123" },
  });
});

test("rejects a wrong secret and a modified body", () => {
  assert.deepEqual(
    verifyWebhook({ rawBody, headers: signedHeaders(rawBody, timestamp, "wrong"), secret, now }),
    { valid: false, reason: "INVALID_SIGNATURE" },
  );
  assert.deepEqual(
    verifyWebhook({
      rawBody: Buffer.from('{"event":"changed"}'),
      headers: signedHeaders(),
      secret,
      now,
    }),
    { valid: false, reason: "INVALID_SIGNATURE" },
  );
});

test("looks up headers without case sensitivity and requires both signed headers", () => {
  const headers = signedHeaders();
  assert.equal(
    verifyWebhook({
      rawBody,
      headers: {
        "stellar-timestamp": headers["Stellar-Timestamp"],
        "STELLAR-SIGNATURE": headers["Stellar-Signature"],
      },
      secret,
      now,
    }).valid,
    true,
  );
  assert.deepEqual(
    verifyWebhook({ rawBody, headers: {}, secret, now }),
    { valid: false, reason: "MISSING_HEADER" },
  );
});

test("rejects expired and too-far-future timestamps", () => {
  const expiredAt = new Date(now.getTime() - 301_000).toISOString();
  const futureAt = new Date(now.getTime() + 61_000).toISOString();
  assert.deepEqual(
    verifyWebhook({ rawBody, headers: signedHeaders(rawBody, expiredAt), secret, now }),
    { valid: false, reason: "TIMESTAMP_EXPIRED" },
  );
  assert.deepEqual(
    verifyWebhook({ rawBody, headers: signedHeaders(rawBody, futureAt), secret, now }),
    { valid: false, reason: "TIMESTAMP_TOO_FAR_IN_FUTURE" },
  );
});

test("allows the body-only legacy signature only when explicitly enabled", () => {
  const headers = { "X-Webhook-Signature": signature(rawBody) };
  assert.deepEqual(
    verifyWebhook({ rawBody, headers, secret, now }),
    { valid: false, reason: "MISSING_HEADER" },
  );
  assert.deepEqual(verifyWebhook({ rawBody, headers, secret, now, allowLegacy: true }), {
    valid: true,
    payload: { event: "payment.received", id: "evt_123" },
  });
});

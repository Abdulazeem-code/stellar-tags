import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonOrderStore, paymentMatchesOrder } from "../src/order-store.js";
import { verifyWebhook } from "../src/webhook-verification.js";

const SECRET = "local-test-secret";
const NOW = Date.parse("2026-11-21T10:00:00.000Z");
const RAW_BODY = Buffer.from('{"event":"payment.received","data":{"amount":"12.5000000"}}');
const TIMESTAMP = new Date(NOW).toISOString();

function signedHeaders(rawBody = RAW_BODY, timestamp = TIMESTAMP, secret = SECRET) {
  return {
    "stellar-timestamp": timestamp,
    "stellar-signature": createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
      .digest("hex"),
  };
}

test("verifies webhook signatures and rejects bad and expired signatures", () => {
  assert.equal(verifyWebhook(RAW_BODY, signedHeaders(), SECRET, NOW).valid, true);
  assert.deepEqual(
    verifyWebhook(RAW_BODY, signedHeaders(RAW_BODY, TIMESTAMP, "wrong"), SECRET, NOW),
    { valid: false, reason: "INVALID_SIGNATURE" },
  );
  const oldTimestamp = new Date(NOW - 301_000).toISOString();
  assert.deepEqual(
    verifyWebhook(RAW_BODY, signedHeaders(RAW_BODY, oldTimestamp), SECRET, NOW),
    { valid: false, reason: "TIMESTAMP_EXPIRED" },
  );
});

test("matches only the exact memo and amount", () => {
  const order = { memo: "st-order-1", amount: "12.50" };
  assert.equal(
    paymentMatchesOrder(order, { memo: "st-order-1", amount: "12.5000000" }),
    true,
  );
  assert.equal(
    paymentMatchesOrder(order, { memo: "st-other", amount: "12.50" }),
    false,
  );
  assert.equal(
    paymentMatchesOrder(order, { memo: "st-order-1", amount: "12.49" }),
    false,
  );
});

test("a repeated matching webhook keeps the order paid without duplicate effects", () => {
  const directory = mkdtempSync(join(tmpdir(), "merchant-orders-"));
  try {
    const store = new JsonOrderStore(join(directory, "orders.json"));
    store.create({
      id: "order-1",
      memo: "st-order-1",
      amount: "12.50",
      status: "pending",
    });

    assert.deepEqual(
      store.markPaidIfMatching({
        memo: "st-order-1",
        amount: "12.50",
        paymentId: "tx-1",
      }),
      { matched: true, paid: true, alreadyPaid: false },
    );
    assert.deepEqual(
      store.markPaidIfMatching({
        memo: "st-order-1",
        amount: "12.50",
        paymentId: "tx-1",
      }),
      { matched: true, paid: true, alreadyPaid: true },
    );
    assert.equal(store.get("order-1").paymentId, "tx-1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

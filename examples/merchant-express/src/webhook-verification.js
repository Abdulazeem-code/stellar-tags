import { createHmac, timingSafeEqual } from "node:crypto";

const FUTURE_SKEW_MS = 60_000;
const DEFAULT_TOLERANCE_MS = 300_000;

export function verifyWebhook(rawBody, headers, secret, now = Date.now()) {
  const signature = headers["stellar-signature"];
  const timestamp = headers["stellar-timestamp"];
  if (!Buffer.isBuffer(rawBody) || typeof signature !== "string" || typeof timestamp !== "string") {
    return { valid: false, reason: "MISSING_HEADER" };
  }

  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || now - timestampMs > DEFAULT_TOLERANCE_MS) {
    return { valid: false, reason: "TIMESTAMP_EXPIRED" };
  }
  if (timestampMs - now > FUTURE_SKEW_MS) {
    return { valid: false, reason: "TIMESTAMP_TOO_FAR_IN_FUTURE" };
  }
  if (!/^[a-f\d]{64}$/i.test(signature)) {
    return { valid: false, reason: "INVALID_SIGNATURE" };
  }

  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]))
    .digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) {
    return { valid: false, reason: "INVALID_SIGNATURE" };
  }

  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { valid: false, reason: "INVALID_PAYLOAD" };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "INVALID_PAYLOAD" };
  }
}

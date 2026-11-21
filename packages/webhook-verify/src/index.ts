import { createHmac, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Request, RequestHandler, Response } from "express";

export type VerificationFailureReason =
  | "MISSING_HEADER"
  | "INVALID_SIGNATURE"
  | "TIMESTAMP_EXPIRED"
  | "TIMESTAMP_TOO_FAR_IN_FUTURE"
  | "INVALID_PAYLOAD";

export interface VerifyWebhookOptions {
  rawBody: Buffer | string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  secret: string;
  toleranceSeconds?: number;
  now?: Date;
  allowLegacy?: boolean;
}

export type VerificationResult =
  | { valid: true; payload: Record<string, unknown> }
  | { valid: false; reason: VerificationFailureReason };

export interface ExpressVerifierOptions {
  secret: string;
  toleranceSeconds?: number;
  allowLegacy?: boolean;
}

const FUTURE_SKEW_SECONDS = 60;
const SIGNATURE_PATTERN = /^[a-f\d]{64}$/i;

function headerValue(
  headers: VerifyWebhookOptions["headers"],
  name: string,
): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  if (!key) return undefined;
  const value = headers[key];
  if (typeof value === "string") return value;
  return value?.[0];
}

function checkTimestamp(
  timestamp: string,
  nowSeconds: number,
  toleranceSeconds: number,
): VerificationFailureReason | undefined {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return "TIMESTAMP_EXPIRED";

  const timestampSeconds = timestampMs / 1000;
  if (nowSeconds - timestampSeconds > toleranceSeconds) return "TIMESTAMP_EXPIRED";
  if (timestampSeconds - nowSeconds > FUTURE_SKEW_SECONDS) {
    return "TIMESTAMP_TOO_FAR_IN_FUTURE";
  }
  return undefined;
}

function matchesSignature(secret: string, message: Buffer, signature: string): boolean {
  if (!SIGNATURE_PATTERN.test(signature)) return false;
  const received = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", secret).update(message).digest();
  return received.length === expected.length && timingSafeEqual(expected, received);
}

function parsePayload(rawBody: Buffer): VerificationResult {
  try {
    const payload: unknown = JSON.parse(rawBody.toString("utf8"));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { valid: false, reason: "INVALID_PAYLOAD" };
    }
    return { valid: true, payload: payload as Record<string, unknown> };
  } catch {
    return { valid: false, reason: "INVALID_PAYLOAD" };
  }
}

export function verifyWebhook(options: VerifyWebhookOptions): VerificationResult {
  const rawBody = Buffer.isBuffer(options.rawBody)
    ? options.rawBody
    : Buffer.from(options.rawBody, "utf8");
  const nowSeconds = (options.now?.getTime() ?? Date.now()) / 1000;
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError("toleranceSeconds must be a non-negative finite number");
  }

  const signature = headerValue(options.headers, "stellar-signature");
  const timestamp =
    headerValue(options.headers, "stellar-timestamp") ??
    headerValue(options.headers, "x-webhook-timestamp");

  if (signature && timestamp) {
    const timestampError = checkTimestamp(timestamp, nowSeconds, toleranceSeconds);
    if (timestampError) return { valid: false, reason: timestampError };
    const message = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]);
    if (!matchesSignature(options.secret, message, signature)) {
      return { valid: false, reason: "INVALID_SIGNATURE" };
    }
    return parsePayload(rawBody);
  }

  if (!options.allowLegacy) return { valid: false, reason: "MISSING_HEADER" };
  const legacySignature = headerValue(options.headers, "x-webhook-signature");
  if (!legacySignature) return { valid: false, reason: "MISSING_HEADER" };
  if (timestamp) {
    const timestampError = checkTimestamp(timestamp, nowSeconds, toleranceSeconds);
    if (timestampError) return { valid: false, reason: timestampError };
  }
  if (!matchesSignature(options.secret, rawBody, legacySignature)) {
    return { valid: false, reason: "INVALID_SIGNATURE" };
  }
  return parsePayload(rawBody);
}

export function expressVerifier(options: ExpressVerifierOptions): RequestHandler {
  const requireFromApplication = createRequire(resolve(process.cwd(), "package.json"));
  const express = requireFromApplication("express") as typeof import("express");
  const rawParser = express.raw({ type: "application/json" });

  return (request: Request, response: Response, next) => {
    rawParser(request, response, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      if (!Buffer.isBuffer(request.body)) {
        response.status(400).json({ valid: false, reason: "INVALID_PAYLOAD" });
        return;
      }
      const result = verifyWebhook({
        rawBody: request.body,
        headers: request.headers,
        secret: options.secret,
        toleranceSeconds: options.toleranceSeconds,
        allowLegacy: options.allowLegacy,
      });
      if (!result.valid) {
        response.status(401).json(result);
        return;
      }
      next();
    });
  };
}

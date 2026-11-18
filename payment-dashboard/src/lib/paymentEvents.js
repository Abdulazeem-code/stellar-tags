/**
 * Live payment status updates over Server-Sent Events (#730).
 *
 * The backend exposes `GET /api/payments/:paymentId/events`, a `text/event-stream`
 * response that emits:
 *
 *   - `connected`      — the stream is established
 *   - `snapshot`       — last known status (sent once, right after connecting)
 *   - `payment-update` — every subsequent status change
 *
 * Reconnection is deliberately left to the EventSource API: when the browser
 * drops the connection it re-opens it on its own (honouring the server's
 * `retry:` hint), so callers never need custom retry/backoff logic — they open
 * a subscription and close it when they are done.
 *
 * Usage:
 *
 *   const stop = subscribeToPaymentStatus(paymentId, {
 *     onSnapshot: ({ status }) => setStatus(status),
 *     onUpdate: ({ status }) => setStatus(status),
 *   });
 *   ...
 *   stop();
 */

import { API_BASE } from "../views/shared";

export const CONNECTED_EVENT = "connected";
export const SNAPSHOT_EVENT = "snapshot";
export const PAYMENT_UPDATE_EVENT = "payment-update";

const parseEvent = (event) => {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
};

/**
 * Subscribe to status updates for a single payment.
 *
 * @param {string} paymentId Payment or payment-intent id.
 * @param {object} [handlers]
 * @param {(data: object) => void} [handlers.onConnected] Stream established.
 * @param {(data: object) => void} [handlers.onSnapshot] Last known status.
 * @param {(data: object) => void} [handlers.onUpdate] A status change arrived.
 * @param {(event: Event) => void} [handlers.onError] Connection errors (retries continue automatically).
 * @returns {() => void} Stops the subscription; the browser will not reconnect.
 */
export function subscribeToPaymentStatus(paymentId, handlers = {}) {
  const { onConnected, onSnapshot, onUpdate, onError } = handlers;
  const url = `${API_BASE}/api/payments/${encodeURIComponent(paymentId)}/events`;
  const source = new EventSource(url);

  source.addEventListener(CONNECTED_EVENT, (event) => {
    const data = parseEvent(event);
    if (data && onConnected) onConnected(data);
  });

  source.addEventListener(SNAPSHOT_EVENT, (event) => {
    const data = parseEvent(event);
    if (data && onSnapshot) onSnapshot(data);
  });

  source.addEventListener(PAYMENT_UPDATE_EVENT, (event) => {
    const data = parseEvent(event);
    if (data && onUpdate) onUpdate(data);
  });

  source.addEventListener("error", (event) => {
    if (onError) onError(event);
  });

  return () => source.close();
}

'use strict';

/**
 * Publish via RabbitMQ's HTTP management exchange endpoint (management plugin
 * must be enabled). This uses Node 20+ fetch, requiring no extra npm package.
 * Exchanges and queues must be configured as durable; messages are persistent.
 */
function createRabbitOutboxPublisher({
  url = process.env.RABBITMQ_MANAGEMENT_URL,
  username = process.env.RABBITMQ_USERNAME,
  password = process.env.RABBITMQ_PASSWORD,
  vhost = process.env.RABBITMQ_VHOST || '/',
  exchange = process.env.RABBITMQ_EXCHANGE || 'payment.events',
  routingKey = process.env.RABBITMQ_ROUTING_KEY || 'payments',
  timeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!url || !username || !password) {
    throw new Error('RABBITMQ_MANAGEMENT_URL, RABBITMQ_USERNAME and RABBITMQ_PASSWORD are required');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be positive');
  const endpoint = new URL(`/api/exchanges/${encodeURIComponent(vhost)}/${encodeURIComponent(exchange)}/publish`, url);
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  return async function publish(message) {
    const envelope = {
      id: message.id,
      eventType: message.eventType,
      payload: message.payload,
      createdAt: message.createdAt,
    };
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: {
          message_id: message.id,
          type: message.eventType,
          content_type: 'application/json',
          delivery_mode: 2,
        },
        routing_key: routingKey,
        payload_encoding: 'string',
        payload: JSON.stringify(envelope),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`RabbitMQ publish failed (HTTP ${response.status})`);
    const outcome = await response.json();
    if (outcome?.routed !== true) {
      throw new Error('RabbitMQ message was not routed to a queue');
    }
  };
}

module.exports = { createRabbitOutboxPublisher };

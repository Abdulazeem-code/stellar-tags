const client = require('prom-client');

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'stellar_tags_' });

// Custom counter: total HTTP requests by method, route, status
const httpRequestCounter = new client.Counter({
  name: 'stellar_tags_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// Custom histogram: request duration in seconds
const httpRequestDuration = new client.Histogram({
  name: 'stellar_tags_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/**
 * Express middleware that tracks request count and latency.
 * Attach to app BEFORE route handlers.
 */
function metricsMiddleware(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path ?? req.path ?? 'unknown';
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    };

    httpRequestCounter.inc(labels);
    httpRequestDuration.observe(labels, duration);
  });

  next();
}

/**
 * Returns Prometheus-format metrics as a string.
 */
async function getMetrics() {
  return client.register.metrics();
}

/**
 * Returns the content type for Prometheus scraping.
 */
function getContentType() {
  return client.register.contentType;
}

module.exports = { metricsMiddleware, getMetrics, getContentType };

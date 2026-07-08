const { v4: uuidv4 } = require('uuid');

const CORRELATION_HEADER = 'X-Correlation-ID';

// #31 — Correlation ID middleware for end-to-end request tracing.
// Reuses an incoming X-Correlation-ID header when present, otherwise generates
// a fresh uuidv4. The ID is exposed on req.correlationId and echoed back on the
// response so callers and downstream services can stitch logs together.
const correlationId = (req, res, next) => {
  const incoming = req.get(CORRELATION_HEADER);
  const id = typeof incoming === 'string' && incoming.trim() ? incoming.trim() : uuidv4();

  req.correlationId = id;
  res.set(CORRELATION_HEADER, id);

  // Prefix request logs with the correlation ID so a single API call can be
  // traced end-to-end across the backend's log output.
  res.on('finish', () => {
    console.log(`[Correlation ID: ${id}] ${req.method} ${req.originalUrl} ${res.statusCode}`);
  });

  next();
};

module.exports = { correlationId, CORRELATION_HEADER };

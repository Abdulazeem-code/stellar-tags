require('./config/envCheck');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { createClient } = require('redis');
const { prisma, isPrismaConnectionError } = require('./prismaClient');
const { scheduleCleanupJob } = require('./src/cleanup-cron');
const { scheduleSoftDeletePurgeJob } = require('./src/soft-delete-purge-cron');
const { schedulePoolMonitoring } = require('./src/db-pool-monitor');
const { correlationId } = require('./middleware/correlation');
const { idempotencyMiddleware } = require('./middleware/idempotency');
const Filter = require('bad-words');
const dotenv = require('dotenv');
const timeout = require('connect-timeout');
const compression = require('compression');
const { poolGet, poolRun, poolAll } = require('./src/db');
const { logger } = require('./src/logger');
const pinoHttp = require('pino-http');
const {
  metricsMiddleware,
  getMetrics,
  getContentType,
  setMetricsSources,
} = require('./src/metrics');
const { validateSchema } = require('./src/middleware/validateSchema');
const { buildErrorHandler, notFoundHandler } = require('./src/middleware/errorHandler');
const { ApiError, errorBody } = require('./src/errors');
const { requireJson } = require('./src/middleware/requireJson');
const { bodySizeLimit } = require('./src/middleware/bodyLimit');
const { apiVersion } = require('./src/middleware/apiVersion');
const { deprecationMiddleware } = require('./src/middleware/deprecation');
const Sentry = require('@sentry/node');
const {
  validateMemo,
} = require('./src/utils');

dotenv.config();

// #295 — Only report to Sentry when a DSN is configured, so local/dev/test
// runs without SENTRY_DSN never try to reach out to Sentry.
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

const app = express();

// #31 — Attach a correlation ID to every request before anything else runs so
// all downstream middleware, handlers and logs can reference the same trace.
app.use(correlationId);
app.use(pinoHttp({ logger, autoLogging: false })); // Use autoLogging: false if you want custom logs, or true if you want everything. PR says "Logs incoming HTTP requests", so let's enable it (default is true).
app.use(helmet());

app.use(timeout('10s'));
app.use((err, req, res, next) => {
  if (req.timedout) {
    logger.error(err, `[Correlation ID: ${req.correlationId}] Request Timeout`);
    return next(new ApiError('SERVICE_UNAVAILABLE', undefined, { cause: err }));
  }
  next(err);
});

app.set('query parser', 'simple');
const PORT = process.env.PORT || 5000;
const STELLAR_TAG_DOMAIN = process.env.STELLAR_TAG_DOMAIN;

const envOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://stellar-tags.vercel.app',
  STELLAR_TAG_DOMAIN,
  process.env.VITE_API_BASE,
  ...envOrigins,
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// Apply metrics middleware to track all HTTP requests
app.use(metricsMiddleware);

const REDIS_RETRY_MAX = 5;
const REDIS_RETRY_BASE_DELAY_MS = 500;

const redisClient = process.env.REDIS_URL ? createClient({
  url: process.env.REDIS_URL,
  socket: {
    reconnectStrategy(retries, cause) {
      if (retries >= REDIS_RETRY_MAX) {
        logger.error({ cause }, `Redis connection failed after ${REDIS_RETRY_MAX} retries`);
        return new Error(`Redis connection failed after ${REDIS_RETRY_MAX} retries`);
      }
      const delay = Math.min(2 ** retries * REDIS_RETRY_BASE_DELAY_MS, 10000);
      logger.warn({ cause }, `Redis connection attempt ${retries + 1} failed, retrying in ${delay}ms...`);
      return delay;
    }
  }
}) : null;
if (redisClient) {
  redisClient.on('error', (err) => logger.error(err, 'Redis client error:'));
  redisClient.connect().catch((err) => logger.error(err, 'Redis connection error:'));
}

setMetricsSources({ prisma, redisClient });

const v1Router = require('./src/routes/v1')(redisClient);
const v2Router = require('./src/routes/v2')(redisClient);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  // Use Redis-backed store when available
  store: redisClient ? new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
  }) : undefined,
  // Return the standard RateLimit-* headers only
  standardHeaders: true,
  legacyHeaders: true,
  message: errorBody('RATE_LIMITED', 'Too many requests, please try again later.'),
  // Prometheus scrapes /metrics on a fixed interval from a single address, so
  // counting those scrapes against the shared quota would 429 the scraper.
  skip: (req) => req.path === '/metrics',
  // Key by authenticated user identifier when present (address/username),
  // otherwise fall back to client IP. This lets registered/identified users
  // get a per-account quota rather than being grouped by IP.
  keyGenerator: (req /*, res */) => {
    try {
      // 1) x-api-key (admin or API key users)
      const apiKey = req.headers['x-api-key'] || req.query.api_key;
      if (apiKey) return String(apiKey);

      // 2) JSON body address (e.g., /register)
      if (req.body && typeof req.body.address === 'string' && req.body.address.trim()) {
        return req.body.address.trim();
      }

      // 3) Query params: federation (q with type=id) or address param
      if (req.query) {
        if (req.query.type === 'id' && typeof req.query.q === 'string' && req.query.q.trim()) {
          return req.query.q.trim();
        }
        if (typeof req.query.address === 'string' && req.query.address.trim()) {
          return req.query.address.trim();
        }
        // Some endpoints use q for lookup by name; not an account id — skip.
      }

      // 4) URL path pattern: /v1/accounts/:account
      const m = req.originalUrl && req.originalUrl.match(/\/v1\/accounts\/([^/]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);

      // Default to IP
      return req.ip || (req.connection && req.connection.remoteAddress) || '';
    } catch (err) {
      // On error, fall back to IP so rate limiting still works
      return req.ip || '';
    }
  },
});

// Per-IP limiter specifically for sensitive, unauthenticated endpoints.
// Keys strictly by client IP so brute-force/spam from a single source is
// blocked regardless of how many account ids are rotated in the payload.
const ipLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  store: redisClient ? new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
  }) : undefined,
  standardHeaders: true,
  legacyHeaders: true,
  message: errorBody('RATE_LIMITED', 'Too many requests, please try again later.'),
  keyGenerator: (req) => req.ip || (req.connection && req.connection.remoteAddress) || '',
});

app.use(cors(corsOptions));

// #588 — Per-route request body size limits. A single JSON parser enforces a
// cap that depends on the endpoint type (auth 1kb / standard 10kb / bulk 100kb)
// instead of the previous uniform 10kb, and answers oversized payloads with 413.
app.use(bodySizeLimit);

app.use(limiter);
const isPrimitive = (v) => v === null || v === undefined || typeof v !== 'object';

const rejectNestedObjects = (req, res, next) => {
  const sources = [req.query, req.body];
  for (const source of sources) {
    if (source && typeof source === 'object') {
      for (const val of Object.values(source)) {
        if (!isPrimitive(val)) {
          // Responds directly rather than delegating, so the middleware stays
          // usable on its own — the same way validateSchema behaves.
          return res.status(400).json(
            errorBody(
              'INVALID_INPUT',
              'Invalid parameter type: nested objects and arrays are not allowed.',
              { correlationId: req.correlationId },
            ),
          );
        }
      }
    }
  }
  next();
};

app.use(rejectNestedObjects);

// Enable HTTP response compression for responses exceeding 1KB (1024 bytes)
app.use(compression({ threshold: 1024 }));

scheduleCleanupJob(prisma);
scheduleSoftDeletePurgeJob(prisma);
const poolMonitor = schedulePoolMonitoring(prisma);

// ---------------------------------------------------------------------------
// #51 — ETag Caching Middleware for Federation Endpoint
// ---------------------------------------------------------------------------
const etagCache = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const bodyString = JSON.stringify(body);
    const hash = crypto.createHash('sha256').update(bodyString).digest('hex');
    const etag = `"${hash}"`;

    res.set('ETag', etag);

    const clientEtag = req.get('If-None-Match');
    if (clientEtag && clientEtag === etag) {
      return res.status(304).end();
    }

    return originalJson(body);
  };

  next();
};

app.use('/v1', v1Router);
app.use('/v2', v2Router);

// Expose /metrics endpoint for Prometheus to scrape
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', getContentType());
    const metrics = await getMetrics();
    res.end(metrics);
  } catch (err) {
    logger.error(err, `[Correlation ID: ${req.correlationId}] Metrics error`);
    res.status(500).end(err.message);
  }
});


// Request versioning: URI (/api/v1, /api/v2) first, then Accept-Version /
// API-Version header, defaulting to v1. Routers below then decide routing.
app.use(apiVersion);

// RFC 8594 deprecation headers: attaches Deprecation/Sunset/Link to endpoints
// listed in src/config/deprecations.js and logs a server-side warning.
app.use(deprecationMiddleware());

// v2 first so an explicit /api/v2 request wins over the unversioned fallback.
app.use('/api/v2', v2Router);
// Explicit v1 mount, then /api (no version) and the legacy unversioned root
// both resolve to v1 so existing clients keep working unchanged.
app.use('/api/v1', v1Router);
app.use('/api', v1Router);
app.use('/', v1Router);
// Auth endpoints (email OTP verification) - uses Redis when available
app.use('/auth', require('./src/routes/v1/authRoutes')(redisClient));

// API key management endpoints (rotation, invalidation, listing)
app.use('/auth/api-keys', require('./src/routes/v1/apiKeyRoutes')(redisClient));

// #497 — Expose RSA public key as a JWKS document so external services can
// verify RS256-signed tokens without sharing a secret.
app.get('/.well-known/jwks.json', (_req, res) => {
  try {
    const { getJwks } = require('./src/utils/jwt');
    const jwks = getJwks();
    res.setHeader('Content-Type', 'application/json');
    // Cache for 1 hour — key rotations are infrequent and consumers should
    // re-fetch on verification failure anyway.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(jwks);
  } catch (err) {
    logger.warn({ err }, 'JWKS endpoint: JWT_PUBLIC_KEY is not configured');
    return res.status(503).json({ error: 'JWKS not available: public key not configured.' });
  }
});

app.get('/.well-known/stellar.toml', (_req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.setHeader('Content-Type', 'text/plain');
  res.send(`FEDERATION_SERVER="${process.env.FEDERATION_SERVER_URL || `https://${process.env.STELLAR_TAG_DOMAIN}/federation`}"\n`);
});

app.get('/api/v1/time', (_req, res) => {
  res.status(200).json({ time: new Date().toISOString() });
});

app.get('/health', async (req, res) => {
  const checks = { database: null, redis: null };
  let allOk = true;
  const errors = [];

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'up';
  } catch (err) {
    checks.database = 'down';
    allOk = false;
    errors.push('Database unavailable');
    logger.error(err, `[Correlation ID: ${req.correlationId}] Database health check failed`);
  }

  if (redisClient) {
    try {
      await redisClient.ping();
      checks.redis = 'up';
    } catch (err) {
      checks.redis = 'down';
      allOk = false;
      errors.push('Redis unavailable');
      logger.error(err, `[Correlation ID: ${req.correlationId}] Redis health check failed`);
    }
  } else {
    checks.redis = 'not configured';
  }

  const response = {
    status: allOk ? 'UP' : 'DOWN',
    timestamp: new Date().toISOString(),
    ...checks,
  };

  if (!allOk) {
    response.message = errors.join(', ');
    return res.status(503).json(response);
  }

  return res.status(200).json(response);
});

// #295 — Report 5xx errors to Sentry (via defaultShouldHandleError) before
// they reach our own JSON error handler below.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Unmatched routes and every error share the standard envelope.
app.use(notFoundHandler);
app.use(buildErrorHandler(isPrismaConnectionError));

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10_000;
let isShuttingDown = false;

const gracefulShutdown = (server, prismaClient, signal, redis = null) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`\nReceived ${signal}. Shutting down gracefully...`);

  // Stop the pool monitor so it doesn't produce misleading warnings during
  // the shutdown window.
  poolMonitor.stop();

  const timer = setTimeout(() => {
    logger.error(`Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS / 1000}s, forcing exit.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  server.close(async () => {
    clearTimeout(timer);
    try {
      await prismaClient.$disconnect();
    } catch (err) {
      logger.error(err, 'Error disconnecting Prisma during shutdown:');
    }
    if (redis) {
      try {
        await redis.quit();
      } catch (err) {
        logger.error(err, 'Error disconnecting Redis during shutdown:');
      }
    }
    process.exit(0);
  });
};


if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server successfully initialized on port ${PORT}`);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      logger.error(e, `Port ${PORT} is in use, forcing shutdown so Railway can restart cleanly.`);
      process.exit(1);
    }
  });

  process.on('SIGTERM', (sig) => gracefulShutdown(server, prisma, sig, redisClient));
  process.on('SIGINT', (sig) => gracefulShutdown(server, prisma, sig, redisClient));
}

module.exports = { app, gracefulShutdown, rejectNestedObjects, validateMemo };

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const { createClient } = require('redis');
const { prisma } = require('./prismaClient');
const { scheduleCleanupJob } = require('./src/cleanup-cron');
const timeout = require('connect-timeout');
const compression = require('compression');
const v1Router = require('./src/routes/v1');

require('dotenv').config();

const app = express();

app.use(timeout('10s'));
app.use((err, req, res, next) => {
  if (req.timedout) {
    return res.status(503).json({ error: 'Service Unavailable' });
  }
  next(err);
});

app.set('query parser', 'simple');
const PORT = process.env.PORT || 5000;
const STELLAR_TAG_DOMAIN = process.env.STELLAR_TAG_DOMAIN;

const allowedOrigins = [
  'http://localhost:5173',
  'https://stellar-tags.vercel.app',
  STELLAR_TAG_DOMAIN,
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204,
};

const redisClient = process.env.REDIS_URL ? createClient({
  url: process.env.REDIS_URL
}) : null;
if (redisClient) {
  redisClient.connect().catch((err) => logger.error({ err }, 'Redis connection failed'));
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  store: redisClient ? new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
  }) : undefined,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(cors(corsOptions));
app.use(limiter);
app.use(express.json({ limit: '10kb' }));
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON payload' });
  }
  next(err);
});

const isPrimitive = (v) => v === null || v === undefined || typeof v !== 'object';

const rejectNestedObjects = (req, res, next) => {
  const sources = [req.query, req.body];
  for (const source of sources) {
    if (source && typeof source === 'object') {
      for (const val of Object.values(source)) {
        if (!isPrimitive(val)) {
          return res
            .status(400)
            .json({ detail: 'Invalid parameter type: nested objects and arrays are not allowed.' });
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

// Mount v1 router for both legacy paths and explicit API versioning
app.use('/', v1Router);
app.use('/api/v1', v1Router);

app.get('/.well-known/stellar.toml', (_req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.setHeader('Content-Type', 'text/plain');
  res.send('FEDERATION_SERVER="https://stellar-tags-production.up.railway.app/federation"\n');
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use((err, _req, _res, next) => {
  if (err.type === 'entity.too.large') {
    const error = new Error('Payload too large. Maximum allowed size is 10kb.');
    error.statusCode = 413;
    return next(error);
  }
  next(err);
});

app.use((err, _req, res, next) => {
  const statusCode = err.statusCode || 500;
  const errorMessage = err.message || 'Internal server error';

  if (statusCode === 500) {
    const errorId = crypto.randomUUID();
    logger.error({ err, errorId }, 'Unhandled server error');
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      reference_id: errorId,
    });
  }

  return res.status(statusCode).json({
    success: false,
    error: errorMessage,
    statusCode,
  });
});

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10_000;

let isShuttingDown = false;

const gracefulShutdown = (server, pool, signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Received signal, shutting down gracefully');

  const timer = setTimeout(() => {
    logger.fatal({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  server.close(async () => {
    clearTimeout(timer);
    try {
      await pool.drain();
      await pool.clear();
    } catch (err) {
      logger.error({ err }, 'Error draining DB pool during shutdown');
    }
    process.exit(0);
  });
};

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'Server successfully initialized');
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      logger.fatal({ port: PORT }, 'Port in use, forcing shutdown for clean restart');
      process.exit(1);
    }
  });

  const prismaPool = {
    drain: () => Promise.resolve(),
    clear: () => prisma.$disconnect(),
  };

  process.on('SIGTERM', (sig) => gracefulShutdown(server, prismaPool, sig));
  process.on('SIGINT', (sig) => gracefulShutdown(server, prismaPool, sig));
}

module.exports = { app, prisma, gracefulShutdown, rejectNestedObjects };

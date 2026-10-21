require("./src/utils/tracing");
require("./config/envCheck");
const express = require("express");
const pinoHttp = require("pino-http");
const cors = require("cors");
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const { securityMiddleware } = require("./src/middleware/security");
const { maintenanceMiddleware } = require("./src/middleware/maintenance");
const crypto = require("crypto");
const { createTokenBucketLimiter } = require("./src/middleware/tokenBucketLimiter");
const { createClient } = require("redis");
const {
  createSlidingWindowRateLimiter,
} = require("./src/middleware/slidingWindowRateLimit");
const { createGraphQLMiddleware } = require("./src/graphql");
const { prisma, isPrismaConnectionError } = require("./prismaClient");
const { scheduleCleanupJob } = require("./src/cleanup-cron");
const { scheduleSoftDeletePurgeJob } = require("./src/soft-delete-purge-cron");
const { scheduleReconciliationJob } = require("./src/reconciliation-cron");
const { schedulePoolMonitoring } = require("./src/db-pool-monitor");
const { correlationId } = require("./middleware/correlation");
const dotenv = require("dotenv");
const timeout = require("connect-timeout");
const compression = require("compression");
const { logger, httpLogger } = require("./src/logger");
const {
  metricsMiddleware,
  getMetrics,
  getContentType,
  setMetricsSources,
  setDlqDepthSource,
} = require("./src/metrics");
const { closeDlqQueue, getDlqDepth, hasOpenDlqQueues } = require("./src/dlq");
const {
  buildErrorHandler,
  notFoundHandler,
} = require("./src/middleware/errorHandler");
const { ApiError, errorBody } = require("./src/errors");
const { bodySizeLimit } = require("./src/middleware/bodyLimit");
const { apiVersion } = require("./src/middleware/apiVersion");
const { deprecationMiddleware } = require("./src/middleware/deprecation");
const Sentry = require("@sentry/node");
const {
  normalizeNameTag,
  validateMemo,
} = require("./src/utils");
const { getCachedApprovedOrigins } = require("./src/originCache");
const {
  initSse,
  closeSse,
  isSseStreamPath,
} = require("./src/sse");
const { createHttpServer, describeTlsStatus } = require("./src/config/tls");
const { requireMutualTls, serviceIdentity } = require("./src/middleware/mtls");

dotenv.config();

// #295 ΓÇö Only report to Sentry when a DSN is configured, so local/dev/test
// runs without SENTRY_DSN never try to reach out to Sentry.
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

const app = express();

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Stellar Tags API",
      version: "1.0.0",
      description: "API for Stellar Tags",
    },
    servers: [
      {
        url: "http://localhost:5000",
      },
    ],
  },
  apis: ["./server.js", "./src/routes/v1/*.js"],
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);

// #31 — Attach a correlation ID to every request before anything else runs so
// all downstream middleware, handlers and logs can reference the same trace.
app.use(correlationId);

// #736 — Mutual TLS. `serviceIdentity` names the calling service from its
// client certificate so request logs and audit trails can attribute internal
// traffic, and `requireMutualTls` rejects anything that arrived without one.
// Both are no-ops while MTLS_ENABLED is false, and the /api-docs mount is
// deliberately below them so no route is reachable on an internal listener
// without a certificate.
app.use(serviceIdentity);
app.use(requireMutualTls);

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use(pinoHttp({ logger, autoLogging: false })); // Use autoLogging: false if you want custom logs, or true if you want everything. PR says "Logs incoming HTTP requests", so let's enable it (default is true).
app.disable("x-powered-by");
app.use(securityMiddleware);
app.use(maintenanceMiddleware);

app.use(timeout("10s"));
app.use((err, req, res, next) => {
  if (req.timedout) {
    (req.log || logger).error({ err }, "Request Timeout");
    return next(new ApiError("SERVICE_UNAVAILABLE", undefined, { cause: err }));
  }
  next(err);
});

app.set("query parser", "simple");
const PORT = process.env.PORT || 5000;
const STELLAR_TAG_DOMAIN = process.env.STELLAR_TAG_DOMAIN;

const envOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://stellar-tags.vercel.app",
  STELLAR_TAG_DOMAIN,
  process.env.VITE_API_BASE,
  ...envOrigins,
].filter(Boolean);

const corsOptions = {
  origin: async (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    try {
      const approvedOrigins = await getCachedApprovedOrigins(redisClient, () =>
        prisma.approvedOrigin
          .findMany({ select: { origin: true } })
          .then((rows) => rows.map((row) => row.origin)),
      );
      if (approvedOrigins && approvedOrigins.includes(origin)) {
        return callback(null, true);
      }
    } catch (err) {
      logger.error(
        err,
        "Failed to validate CORS origin against approved origins",
      );
    }
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Apply metrics middleware to track all HTTP requests
app.use(metricsMiddleware);

const REDIS_RETRY_MAX = 5;
const REDIS_RETRY_BASE_DELAY_MS = 500;

const redisClient = process.env.REDIS_URL
  ? createClient({
      url: process.env.REDIS_URL,
      socket: {
        reconnectStrategy(retries, cause) {
          if (retries >= REDIS_RETRY_MAX) {
            logger.error(
              { cause },
              `Redis connection failed after ${REDIS_RETRY_MAX} retries`,
            );
            return new Error(
              `Redis connection failed after ${REDIS_RETRY_MAX} retries`,
            );
          }
          const delay = Math.min(
            2 ** retries * REDIS_RETRY_BASE_DELAY_MS,
            10000,
          );
          logger.warn(
            { cause },
            `Redis connection attempt ${retries + 1} failed, retrying in ${delay}ms...`,
          );
          return delay;
        },
      },
    })
  : null;
if (redisClient) {
  redisClient.on("error", (err) => logger.error(err, "Redis client error:"));
  redisClient
    .connect()
    .catch((err) => logger.error(err, "Redis connection error:"));
}

setMetricsSources({ prisma, redisClient });
// Lets /metrics report DLQ depth without the metrics module importing BullMQ.
setDlqDepthSource(getDlqDepth);

const v1Router = require("./src/routes/v1")(redisClient);
const v2Router = require("./src/routes/v2")(redisClient);
const userRoutes = require("./src/routes/v1/userRoutes")(redisClient);
const federationRoutes = require("./src/routes/v1/federationRoutes")(redisClient);
const graphQLMiddleware = createGraphQLMiddleware({ prismaClient: prisma });

const limiter = createTokenBucketLimiter(redisClient, {
  capacity: 100,
  refillRate: 100 / (15 * 60), // 100 requests per 15 minutes
  prefix: 'global-rl:',
  // SSE streams are exempt: an EventSource reconnect loop must not consume a
  // caller's REST quota. They are bounded separately by a per-IP limiter on
  // the stream route itself (src/routes/v1/sseRoutes.js).
  skip: (req) => req.path === "/metrics" || isSseStreamPath(req.path),
  // Key by authenticated user identifier when present (address/username),
  // otherwise fall back to client IP. This lets registered/identified users
  // get a per-account quota rather than being grouped by IP.
  keyGenerator: (req /*, res */) => {
    try {
      // 1) x-api-key (admin or API key users)
      const apiKey = req.headers["x-api-key"] || req.query.api_key;
      if (apiKey) return String(apiKey);

      // 2) JSON body address (e.g., /register)
      if (
        req.body &&
        typeof req.body.address === "string" &&
        req.body.address.trim()
      ) {
        return req.body.address.trim();
      }

      // 3) Query params: federation (q with type=id) or address param
      if (req.query) {
        if (
          req.query.type === "id" &&
          typeof req.query.q === "string" &&
          req.query.q.trim()
        ) {
          return req.query.q.trim();
        }
        if (typeof req.query.address === "string" && req.query.address.trim()) {
          return req.query.address.trim();
        }
        // Some endpoints use q for lookup by name; not an account id ΓÇö skip.
      }

      // 4) URL path pattern: /v1/accounts/:account
      const m =
        req.originalUrl && req.originalUrl.match(/\/v1\/accounts\/([^/]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);

      // Default to IP
      return req.ip || (req.connection && req.connection.remoteAddress) || "";
    } catch (err) {
      // On error, fall back to IP so rate limiting still works
      return req.ip || "";
    }
  },
});

// #588 — Per-route request body size limits. A single JSON parser enforces a
// cap that depends on the endpoint type (auth 1kb / standard 10kb / bulk 100kb)
// instead of the previous uniform 10kb, and answers oversized payloads with 413.
app.use(bodySizeLimit);

app.use(limiter);
const isPrimitive = (v) =>
  v === null || v === undefined || typeof v !== "object";

const rejectNestedObjects = (req, res, next) => {
  // GraphQL variables are intentionally nested; field-level schema validation
  // replaces the flat-input guard used by the REST API.
  if (req.path === "/graphql") return next();

  const sources = [req.query, req.body];
  for (const source of sources) {
    if (source && typeof source === "object") {
      for (const val of Object.values(source)) {
        if (!isPrimitive(val)) {
          // Responds directly rather than delegating, so the middleware stays
          // usable on its own ΓÇö the same way validateSchema behaves.
          return res
            .status(400)
            .json(
              errorBody(
                "INVALID_INPUT",
                "Invalid parameter type: nested objects and arrays are not allowed.",
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
app.use("/graphql", graphQLMiddleware);

scheduleCleanupJob(prisma);
scheduleSoftDeletePurgeJob(prisma);
scheduleReconciliationJob(prisma);
const poolMonitor = schedulePoolMonitoring(prisma);

// RESERVED_USERNAMES is imported from ./src/utils at the top of the file.



// Expose /metrics endpoint for Prometheus to scrape

/**
 * @openapi
 * /metrics:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /metrics
 *     responses:
 *       200:
 *         description: Success
 */
app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", getContentType());
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
app.use("/api/v2", v2Router);
// Explicit v1 mount, then /api (no version) and the legacy unversioned root
// both resolve to v1 so existing clients keep working unchanged.
app.use("/api/v1", v1Router);
// #492 — Strict rate limiter for auth/login endpoints. These are prime
// brute-force targets, so they get a much tighter budget than the global
// limiter. Uses the same Redis-backed store so the limit is shared across
// all distributed nodes.
const authLimiter = createTokenBucketLimiter(redisClient, {
  capacity: 20,
  refillRate: 20 / (15 * 60), // 20 requests per 15 minutes
  prefix: 'auth-rl:',
  keyGenerator: (req) =>
    req.ip || (req.connection && req.connection.remoteAddress) || "",
});

app.use("/api", v1Router);
app.use("/", v1Router);
app.use("/", userRoutes);
app.use("/", federationRoutes);
// Auth endpoints (email OTP verification) - uses Redis when available
app.use(
  "/auth",
  authLimiter,
  require("./src/routes/v1/authRoutes")(redisClient),
);

// API key management endpoints (rotation, invalidation, listing)
app.use("/auth/api-keys", require("./src/routes/v1/apiKeyRoutes")(redisClient));

// #497 ΓÇö Expose RSA public key as a JWKS document so external services can
// verify RS256-signed tokens without sharing a secret.

/**
 * @openapi
 * /.well-known/jwks.json:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /.well-known/jwks.json
 *     responses:
 *       200:
 *         description: Success
 */
app.get("/.well-known/jwks.json", (_req, res) => {
  try {
    const { getJwks } = require("./src/utils/jwt");
    const jwks = getJwks();
    res.setHeader("Content-Type", "application/json");
    // Cache for 1 hour ΓÇö key rotations are infrequent and consumers should
    // re-fetch on verification failure anyway.
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.json(jwks);
  } catch (err) {
    logger.warn({ err }, "JWKS endpoint: JWT_PUBLIC_KEY is not configured");
    return res
      .status(503)
      .json({ error: "JWKS not available: public key not configured." });
  }
});

/**
 * @openapi
 * /.well-known/stellar.toml:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /.well-known/stellar.toml
 *     responses:
 *       200:
 *         description: Success
 */
app.get("/.well-known/stellar.toml", (_req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/plain");
  res.send(
    `FEDERATION_SERVER="${process.env.FEDERATION_SERVER_URL || `https://${process.env.STELLAR_TAG_DOMAIN}/federation`}"\n`,
  );
});

/**
 * @openapi
 * /api/v1/time:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /api/v1/time
 *     responses:
 *       200:
 *         description: Success
 */
app.get("/api/v1/time", (_req, res) => {
  res.status(200).json({ time: new Date().toISOString() });
});

app.use(require("./src/routes/v1/healthRoutes")(redisClient));

// #295 ΓÇö Report 5xx errors to Sentry (via defaultShouldHandleError) before
// they reach our own JSON error handler below.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Unmatched routes and every error share the standard envelope.
app.use(notFoundHandler);
app.use(buildErrorHandler(isPrismaConnectionError));

const SHUTDOWN_TIMEOUT_MS =
  parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10_000;
let isShuttingDown = false;

const gracefulShutdown = (server, prismaClient, signal, redis = null) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`\nReceived ${signal}. Shutting down gracefully...`);

  // Stop the pool monitor so it doesn't produce misleading warnings during
  // the shutdown window.
  poolMonitor.stop();

  const timer = setTimeout(() => {
    logger.error(
      `Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS / 1000}s, forcing exit.`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  // Close every open SSE stream before the HTTP server so the long-lived
  // streaming responses do not keep sockets (and server.close()) alive.
  closeSse().then(() => {
    server.close(async () => {
      clearTimeout(timer);
      try {
        await prismaClient.$disconnect();
      } catch (err) {
        logger.error(err, "Error disconnecting Prisma during shutdown:");
      }
      if (redis) {
        try {
          await redis.quit();
        } catch (err) {
          logger.error(err, "Error disconnecting Redis during shutdown:");
        }
      }
      // Only await when the DLQ was actually used, so a process that never
      // opened it does not pay for an extra async hop during shutdown.
      if (hasOpenDlqQueues()) {
        try {
          await closeDlqQueue();
        } catch (err) {
          logger.error(err, "Error closing the DLQ queues during shutdown:");
        }
      }
      process.exit(0);
    });
  });
};

if (require.main === module) {
  const {
    checkMigrations,
    enforceMigrationPolicy,
  } = require("./src/migrate-check");

  const startServer = () => {
    // createHttpServer returns an https listener that demands a client
    // certificate when mTLS is enabled, and a plain http listener otherwise.
    let server;
    try {
      server = createHttpServer(app);
    } catch (err) {
      // Refuse to start rather than silently serving in clear when the
      // certificate material is unusable.
      logger.error({ err: err.message }, "[mtls] Refusing to start: invalid TLS configuration.");
      process.exit(1);
    }
    const tlsStatus = describeTlsStatus();

    server.listen(PORT, "0.0.0.0", () => {
      logger.info(`Server successfully initialized on port ${PORT}`);
      logger.info(
        { tls: tlsStatus },
        `Transport: ${tlsStatus.transport.toUpperCase()}${
          tlsStatus.clientCertificateRequired
            ? " with mandatory client certificates"
            : ""
        }`,
      );
    });

    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        logger.error(
          e,
          `Port ${PORT} is in use, forcing shutdown so Railway can restart cleanly.`,
        );
        process.exit(1);
      }
    });

    // Subscribe to the Redis payment channel so status changes published by
    // other processes (e.g. the Horizon listener) are forwarded to connected
    // EventSource clients. SSE itself needs no server attachment — the stream
    // routes are ordinary Express handlers and CORS is enforced by the
    // regular cors() middleware already in the chain.
    initSse();

    process.on("SIGTERM", (sig) =>
      gracefulShutdown(server, prisma, sig, redisClient),
    );
    process.on("SIGINT", (sig) =>
      gracefulShutdown(server, prisma, sig, redisClient),
    );
  };

  // Verify the database is not out of sync with the Prisma migrations before
  // binding a port, so schema drift surfaces as a clear startup error instead
  // of a cryptic failure on the first query. In strict mode this exits
  // (non-zero) when migrations are pending; in permissive mode it warns and
  // continues. The server only boots once the result is known.
  checkMigrations()
    .then((result) => {
      const { shouldExit } = enforceMigrationPolicy(result);
      if (shouldExit) {
        logger.error(
          "[migrate-check] Aborting startup: database migrations are not applied.",
        );
        process.exit(1);
      }
      startServer();
    })
    .catch((err) => {
      // Unexpected failure running the check itself ΓÇö refuse to start deceptively
      // healthy when we couldn't validate schema parity.
      logger.error(
        err,
        "[migrate-check] Failed to verify migration status at startup.",
      );
      process.exit(1);
    });
}

module.exports = {
  app,
  createHttpServer,
  gracefulShutdown,
  rejectNestedObjects,
  validateMemo,
  normalizeNameTag,
};

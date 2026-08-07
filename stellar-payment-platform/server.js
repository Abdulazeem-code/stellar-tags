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
const { verifyMultiSignerThreshold } = require('./src/multisigner-verifier');
const { poolGet, poolRun, poolAll } = require('./src/db');
const { logger } = require('./src/logger');
const xss = require('xss');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');
const swaggerUi = require('swagger-ui-express');
const { swaggerSpec } = require('./src/swagger');
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
const {
  registerBodySchema,
  federationQuerySchema,
  lookupQuerySchema,
  usersQuerySchema,
} = require('./src/schemas');
const Sentry = require('@sentry/node');
const {
  lookupCached,
  federationNameKey,
  federationIdKey,
  federationLookupCached,
  invalidateFederationCache,
} = require('./src/cache');
const { paginatedResponse } = require('./src/pagination');
const {
  normalizeNameTag,
  validateMemo,
  RESERVED_NAMES,
  USER_DATABASE,
  shouldFallbackToLocalRegistry,
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
app.use(helmet());

app.use(timeout('10s'));
app.use((err, req, res, next) => {
  if (req.timedout) {
    logger.error(`[Correlation ID: ${req.correlationId}] Request Timeout`, err);
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
  optionsSuccessStatus: 204,
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
        logger.error(`Redis connection failed after ${REDIS_RETRY_MAX} retries`, { cause });
        return new Error(`Redis connection failed after ${REDIS_RETRY_MAX} retries`);
      }
      const delay = Math.min(2 ** retries * REDIS_RETRY_BASE_DELAY_MS, 10000);
      logger.warn(`Redis connection attempt ${retries + 1} failed, retrying in ${delay}ms...`, { cause });
      return delay;
    }
  }
}) : null;
if (redisClient) {
  redisClient.on('error', (err) => logger.error('Redis client error:', err));
  redisClient.connect().catch((err) => logger.error('Redis connection error:', err));
}

setMetricsSources({ prisma, redisClient });

const v1Router = require('./src/routes/v1')(redisClient);

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

app.use(cors(corsOptions));
app.use(limiter);
app.use(express.json({ limit: '10kb' }));
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

// ---------------------------------------------------------------------------
// Swagger UI — interactive API documentation available at /api-docs
// ---------------------------------------------------------------------------
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Stellar Tags API Docs',
  swaggerOptions: { persistAuthorization: true },
}));

scheduleCleanupJob(prisma);
scheduleSoftDeletePurgeJob(prisma);
const poolMonitor = schedulePoolMonitoring(prisma);

const RESERVED_USERNAMES = [
  'admin',
  'root',
  'stellar',
  'system',
  'superuser',
  'administrator',
  'support',
];

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

const getLocalUserByAddress = async (address) =>
  poolGet(
    'SELECT username, address FROM username_registry WHERE address = ? LIMIT 1',
    [address],
  );

const getLocalUserByUsername = async (username) =>
  poolGet(
    'SELECT username, address FROM username_registry WHERE username = ? LIMIT 1',
    [username],
  );

const listLocalUsers = async (search, page, limit) => {
  const searchPattern = `%${search}%`;
  const skip = (page - 1) * limit;
  const rows = await poolAll(
    `SELECT username, address, created_at
     FROM username_registry
     WHERE username LIKE ? COLLATE NOCASE OR address LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [searchPattern, searchPattern, limit, skip],
  );

  const countRow = await poolGet(
    `SELECT COUNT(*) AS totalCount
     FROM username_registry
     WHERE username LIKE ? COLLATE NOCASE OR address LIKE ? COLLATE NOCASE`,
    [searchPattern, searchPattern],
  );

  const totalCount = Number(countRow?.totalCount || 0);
  return paginatedResponse(
    rows.map((user) => ({
      username: user.username,
      address: user.address,
      created_at: user.created_at,
    })),
    totalCount,
    { page, limit },
  );
};

const registerLocalUser = async ({ username, address }) => {
  const existingByAddress = await getLocalUserByAddress(address);
  if (existingByAddress) {
    const conflictError = new Error('Address already registered');
    conflictError.statusCode = 409;
    throw conflictError;
  }

  const existingByUsername = await getLocalUserByUsername(username);
  if (existingByUsername) {
    const conflictError = new Error('Username is already taken. Please choose another.');
    conflictError.statusCode = 409;
    throw conflictError;
  }

  await poolRun(
    `INSERT INTO username_registry (username, address, created_at)
     VALUES (?, ?, ?)`,
    [username, address, new Date().toISOString()],
  );
};

/**
 * @swagger
 * /federation:
 *   get:
 *     summary: Resolve a username tag or Stellar address via the federation protocol
 *     description: >
 *       Implements the Stellar federation protocol. Use `type=name` (default) to
 *       resolve a username tag (e.g. `alice*localhost`) to a Stellar address, or
 *       `type=id` to do the reverse lookup by Stellar public key.
 *     tags:
 *       - Federation
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: >
 *           The value to look up. For `type=name` provide a username tag
 *           (e.g. `alice*localhost`). For `type=id` provide a Stellar public key.
 *         example: alice*localhost
 *       - in: query
 *         name: type
 *         required: false
 *         schema:
 *           type: string
 *           enum: [name, id]
 *           default: name
 *         description: >
 *           Federation query type. `name` resolves a tag to an address;
 *           `id` resolves an address to a tag.
 *     responses:
 *       200:
 *         description: Record found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FederationResponse'
 *             examples:
 *               nameResolution:
 *                 summary: Resolve username tag → address
 *                 value:
 *                   stellar_address: alice*localhost
 *                   account_id: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *               withMemo:
 *                 summary: Response with optional memo fields
 *                 value:
 *                   stellar_address: alice*localhost
 *                   account_id: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *                   memo_type: text
 *                   memo: payment-ref-001
 *       400:
 *         description: Missing `q` parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: "Missing 'q' parameter"
 *               statusCode: 400
 *       404:
 *         description: Name tag or address not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: Name tag not found
 *               statusCode: 404
 *       500:
 *         description: Database lookup failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// Expose /metrics endpoint for Prometheus to scrape
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', getContentType());
    const metrics = await getMetrics();
    res.end(metrics);
  } catch (err) {
    logger.error(`[Correlation ID: ${req.correlationId}] Metrics error`, err);
    res.status(500).end(err.message);
  }
});

app.get('/federation', etagCache, validateSchema({ query: federationQuerySchema }), async (req, res, next) => {
  const { q: queryValue, type } = req.query;

  try {
    if (type === 'id') {
      const cacheKey = federationIdKey(queryValue);
      const cached = await federationLookupCached(cacheKey, async () => {
        const row = await prisma.user.findFirst({
          where: { address: { equals: queryValue, mode: 'insensitive' }, deletedAt: null },
          select: { username: true, address: true, memoType: true, memo: true, flaggedAt: true },
        });

        if (!row) return null;
        if (row.flaggedAt) {
          const forbiddenError = new Error('Address is blocked');
          forbiddenError.statusCode = 403;
          throw forbiddenError;
        }

        const response = {
          stellar_address: `${row.username}*${process.env.DOMAIN || 'localhost'}`,
          account_id: row.address,
        };
        if (row.memoType) {
          response.memo_type = row.memoType;
          response.memo = row.memo;
        }
        return response;
      });

      if (!cached) {
        const notFoundError = new Error('Address not found');
        notFoundError.statusCode = 404;
        return next(notFoundError);
      }

      return res.json(cached);
    } else if (type === 'name' || !type) {
      const nameTag = normalizeNameTag(queryValue);
      const queryName = nameTag.toLowerCase();
      const cacheKey = federationNameKey(queryName);

      const cached = await federationLookupCached(cacheKey, async () => {
        let row;
        try {
          row = await prisma.user.findFirst({
            where: { username: queryName, deletedAt: null },
            select: { address: true, memoType: true, memo: true, flaggedAt: true },
          });

          if (row && row.flaggedAt) {
            const forbiddenError = new Error('Address is blocked');
            forbiddenError.statusCode = 403;
            throw forbiddenError;
          }
        } catch (error) {
          if (error.statusCode === 403) throw error;
          if (!shouldFallbackToLocalRegistry(error)) {
            throw error;
          }

          const localRow = await getLocalUserByUsername(queryName);
          row = localRow
            ? { address: localRow.address, memoType: null, memo: null }
            : null;
        }

        const address = row?.address || USER_DATABASE[queryName];
        if (!address) return null;

        const response = {
          stellar_address: address,
          account_id: address,
        };
        if (row?.memoType) {
          response.memo_type = row.memoType;
          response.memo = row.memo;
        }
        return response;
      });

      if (!cached) {
        const notFoundError = new Error('Name tag not found');
        notFoundError.statusCode = 404;
        return next(notFoundError);
      }

      return res.json(cached);
    } else {
      return next(
        new ApiError('INVALID_INPUT', "Unsupported query type. Supported types: 'id', 'name'"),
      );
    }
  } catch (error) {
    const dbError = new Error('Database lookup failed', { cause: error });
    dbError.statusCode = 500;
    return next(dbError);
  }
});

// Initialise profanity filter once at module load (reused across requests).
const profanityFilter = new Filter();
const verifyFreighterRegistrationSignature = ({
  username,
  address,
  signature,
  signerAddress,
}) => {
  const message = `register:${username}:${address}`;
  const claimedSigner = signerAddress || address;

  if (!StrKey.isValidEd25519PublicKey(claimedSigner)) {
    const error = new Error('Invalid signer address format.');
    error.statusCode = 400;
    throw error;
  }

  const keypair = Keypair.fromPublicKey(claimedSigner);

  let signatureBuffer;
  if (Buffer.isBuffer(signature)) {
    signatureBuffer = signature;
  } else if (typeof signature === 'string') {
    signatureBuffer = Buffer.from(signature, 'base64');
  } else {
    throw new Error('Invalid message signature format.');
  }

  // --- SEP-0053 Verification Logic ---
  // Freighter adds a specific prefix and hashes the payload before signing
  const prefix = Buffer.from('Stellar Signed Message:\n', 'utf8');
  const messageBytes = Buffer.from(message, 'utf8');
  const payload = Buffer.concat([prefix, messageBytes]);
  const messageHash = crypto.createHash('sha256').update(payload).digest();

  // Verify against the hashed payload, not the raw string!
  if (!keypair.verify(messageHash, signatureBuffer)) {
    const error = new Error('Signature verification failed.');
    error.statusCode = 401;
    throw error;
  }

  if (claimedSigner !== address) {
    const error = new Error('Signer address does not match the connected wallet.');
    error.statusCode = 401;
    throw error;
  }

  return claimedSigner;
};

/**
 * @swagger
 * /register:
 *   post:
 *     summary: Register a new username–address mapping
 *     description: >
 *       Associates a human-readable username tag with a Stellar public key.
 *       Optionally accepts a SEP-0053 signature for multi-signer threshold
 *       verification. The endpoint is idempotent for the same
 *       (username, address) pair when an idempotency key header is supplied.
 *     tags:
 *       - Registration
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterRequest'
 *           examples:
 *             minimal:
 *               summary: Minimal registration (no signature)
 *               value:
 *                 username: alice
 *                 address: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *             withMemo:
 *               summary: Registration with a text memo
 *               value:
 *                 username: alice
 *                 address: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *                 memo_type: text
 *                 memo: payment-ref-001
 *             withSignature:
 *               summary: Registration with Freighter signature (SEP-0053)
 *               value:
 *                 username: alice
 *                 address: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *                 signature: BASE64_ENCODED_SIGNATURE
 *                 signerAddress: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *     responses:
 *       201:
 *         description: Registration successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RegisterResponse'
 *             example:
 *               ok: true
 *               username: alice*localhost
 *               address: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *               federation_address: alice*localhost
 *       400:
 *         description: >
 *           Missing or invalid fields (username, address, memo validation,
 *           reserved username, or secret key detected).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: "Missing required fields: username and address are both required."
 *               statusCode: 400
 *       401:
 *         description: Signature verification failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Reserved username
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: This username is reserved and cannot be registered.
 *               statusCode: 403
 *       409:
 *         description: Address or username already registered
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: Address already registered
 *               statusCode: 409
 *       415:
 *         description: Content-Type must be application/json
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Database insertion or verification failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post('/register', idempotencyMiddleware(redisClient), requireJson, validateSchema({ body: registerBodySchema }), async (req, res, next) => {
  // registerBodySchema has already guaranteed that username is a trimmed
  // 3-20 character alphanumeric string and address is a non-empty trimmed
  // string, so those shape checks are not repeated here.
  const safeUsername = xss(req.body.username);
  const username = normalizeNameTag(safeUsername);
  const { address, memo_type: memoType, memo, signature = '', signerAddress = '' } = req.body;

  if (address.toUpperCase().startsWith('S')) {
    return next(
      new ApiError(
        'INVALID_INPUT',
        'Never share your Secret Key. Please register using your Public Key (starts with G).',
      ),
    );
  }

  // Extract the username part before the * for the profanity check
  const usernameLocalPart = username.includes('*') ? username.split('*')[0] : username;

  // Reject usernames containing profanity or offensive words.
  if (profanityFilter.isProfane(usernameLocalPart)) {
    return next(new ApiError('INVALID_INPUT', 'Username contains restricted words'));
  }

  if (!StrKey.isValidEd25519PublicKey(address)) {
    const error = new Error('Invalid Stellar Public Key format.');
    error.statusCode = 400;
    return next(error);
  }

  const memoError = validateMemo(memoType, memo);
  if (memoError) {
    return next(new ApiError('INVALID_INPUT', memoError));
  }

  const normalizedUsername = username.toLowerCase();
  
  const normalizedLocalPart = normalizedUsername.includes('*') ? normalizedUsername.split('*')[0] : normalizedUsername;
  if (RESERVED_USERNAMES.includes(normalizedLocalPart)) {
    return res.status(403).json({ error: "Username is reserved." });
  }

  const RESERVED_NAMES = ['admin', 'root', 'support', 'system', 'stellar', 'api', 'help'];
  if (RESERVED_NAMES.includes(normalizedUsername)) {
    return next(new ApiError('FORBIDDEN', 'This username is reserved and cannot be registered.'));
  }

  try {
    let existing = null;
    try {
      existing = await prisma.user.findFirst({
        where: { address, deletedAt: null },
      });
    } catch (error) {
      if (!shouldFallbackToLocalRegistry(error)) {
        throw error;
      }

      existing = await getLocalUserByAddress(address);
    }

    if (existing) {
      const conflictError = new Error('Address already registered');
      conflictError.statusCode = 409;
      return next(conflictError);
    }

    let verificationResult = null;
    if (signature) {
      const isLegacyPublicKeyFlow =
        StrKey.isValidEd25519PublicKey(signature) && !signerAddress;

      if (isLegacyPublicKeyFlow) {
        verificationResult = await verifyMultiSignerThreshold(address, [signature], {
          operationType: 'management',
        });

        if (!verificationResult.success) {
          const verificationError = new Error(
            verificationResult.errorMessage || 'Signature verification failed'
          );
          verificationError.statusCode = 401;
          throw verificationError;
        }
      } else {
        const claimedSigner = verifyFreighterRegistrationSignature({
          username: req.body.username,
          address: req.body.address, // Make sure this is using the raw body too!
          signature,
          signerAddress,
        });

        verificationResult = {
          success: true,
          accountId: claimedSigner,
          operationType: 'message',
          requiredThreshold: 1,
          totalWeight: 1,
          signatureCount: 1,
          uniqueSignerCount: 1,
          signatures: [
            {
              publicKey: claimedSigner,
              weight: 1,
              isValid: true,
            },
          ],
          thresholds: {
            low_threshold: 1,
            med_threshold: 1,
            high_threshold: 1,
          },
          signerCount: 1,
          errorMessage: null,
        };
      }
    }

    try {
      await prisma.user.create({
        data: {
          username: normalizedUsername,
          address,
          ...(memoType && { memoType, memo }),
        },
      });
      // Invalidate any stale federation cache entries for this username/address
      invalidateFederationCache(normalizedUsername, address);
    } catch (error) {
      if (!shouldFallbackToLocalRegistry(error)) {
        throw error;
      }

      await registerLocalUser({ username: normalizedUsername, address });
    }

    return res.status(201).json({
      ok: true,
      username: normalizedUsername,
      address,
      federation_address: `${normalizedUsername}*${process.env.DOMAIN || 'localhost'}`,
      ...(verificationResult && {
        verification: {
          accountId: verificationResult.accountId,
          signerCount: verificationResult.signerCount,
          thresholdMet: verificationResult.success,
          requiredThreshold: verificationResult.requiredThreshold,
          providedWeight: verificationResult.totalWeight,
        },
      }),
      ...(memoType && { memo_type: memoType, memo }),
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT' || (error.message && error.message.includes('UNIQUE'))) {
      return next(new ApiError('CONFLICT', 'Username is already taken. Please choose another.'));
    }
    
    // Handle verification errors
    if (error.message && error.message.includes('Account not found')) {
      const notFoundError = new Error(`Account not found on Horizon: ${address}`);
      notFoundError.statusCode = 404;
      return next(notFoundError);
    }

    // Handle signature verification errors
    if (error.statusCode === 401) {
      return next(error);
    }

    // Handle other errors
    logger.error('Registration error:', error.message);
    const registrationError = new Error(`Registration verification failed: ${error.message}`);
    registrationError.statusCode = 500;
    return next(registrationError);
  }
});

app.all('/register', (req, res, next) => next(new ApiError('METHOD_NOT_ALLOWED')));

/**
 * @swagger
 * /lookup:
 *   get:
 *     summary: Look up a username by Stellar address, or search users
 *     description: >
 *       Two modes of operation:
 *       1. **Exact lookup** — supply `address` to retrieve the username registered
 *          to that Stellar public key.
 *       2. **Paginated search** — supply `search` to find users whose username or
 *          address contains the given string (case-insensitive).
 *
 *       Exactly one of `address` or `search` must be provided.
 *     tags:
 *       - Lookup
 *     parameters:
 *       - in: query
 *         name: address
 *         schema:
 *           type: string
 *         description: Stellar public key for exact reverse-lookup.
 *         example: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Partial username or address string for paginated search.
 *         example: alice
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *         description: Page number (search mode only).
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 100
 *         description: Results per page (search mode only).
 *     responses:
 *       200:
 *         description: Record(s) found
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/LookupResponse'
 *                 - $ref: '#/components/schemas/LookupPagedResponse'
 *             examples:
 *               exactLookup:
 *                 summary: Exact address lookup
 *                 value:
 *                   username: alice*localhost
 *                   address: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *               pagedSearch:
 *                 summary: Paginated search results
 *                 value:
 *                   data:
 *                     - username: alice*localhost
 *                       address: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *                       created_at: '2024-01-15T10:30:00.000Z'
 *                   totalCount: 1
 *                   totalPages: 1
 *                   currentPage: 1
 *       400:
 *         description: Neither `address` nor `search` was provided
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: "Missing required parameter: provide 'address' for exact lookup or 'search' for paginated search"
 *               statusCode: 400
 *       404:
 *         description: No username registered for the given address
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: Username not found for this address
 *               statusCode: 404
 *       500:
 *         description: Database lookup failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.get('/lookup', async (req, res, next) => {
  const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  if (!address && !search) {
    const error = new Error("Missing required parameter: provide 'address' for exact lookup or 'search' for paginated search");
    error.statusCode = 400;
    return next(error);
  }
app.get('/lookup', validateSchema({ query: lookupQuerySchema }), async (req, res, next) => {
  const { address = '', search = '' } = req.query;

  if (address) {
    try {
      const result = await lookupCached(address, async () => {
        let row;
        try {
          row = await prisma.user.findFirst({
            where: { address, deletedAt: null },
            select: { username: true },
          });
        } catch (error) {
          if (!shouldFallbackToLocalRegistry(error)) {
            throw error;
          }
          row = await getLocalUserByAddress(address);
        }
        return row ? { username: row.username, address } : null;
      });

      if (!result) {
        const notFoundError = new Error('Username not found for this address');
        notFoundError.statusCode = 404;
        return next(notFoundError);
      }

      return res.json(result);
    } catch (err) {
      logger.error("🚨 ACTUAL PRISMA ERROR:", err);

      const dbError = new Error('Database lookup failed', { cause: err });
      dbError.statusCode = 500;
      return next(dbError);
    }
  }

  const { page, limit } = req.query;
  const skip = (page - 1) * limit;

  const where = {
    deletedAt: null,
    OR: [
      { username: { contains: search, mode: 'insensitive' } },
      { address: { contains: search, mode: 'insensitive' } },
    ],
  };

  try {
    let response = null;
    try {
      const [totalCount, rows] = await prisma.$transaction([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
      ]);

      response = paginatedResponse(
        rows.map((user) => ({
          username: user.username,
          address: user.address,
          created_at: user.createdAt.toISOString(),
        })),
        totalCount,
        { page, limit },
      );
    } catch (error) {
      if (!shouldFallbackToLocalRegistry(error)) {
        throw error;
      }

      response = await listLocalUsers(search, page, limit);
    }

    return res.json(response);
  } catch (error) {
    const dbError = new Error('Database lookup failed', { cause: error });
    dbError.statusCode = 500;
    return next(dbError);
  }
});

/**
 * @swagger
 * /users:
 *   get:
 *     summary: List all registered users with optional search and pagination
 *     description: >
 *       Returns a paginated list of registered username–address pairs.
 *       Optionally filter by a partial username or address string.
 *     tags:
 *       - Lookup
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Filter by partial username or address (case-insensitive).
 *         example: alice
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *         description: Page number.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 100
 *         description: Results per page.
 *     responses:
 *       200:
 *         description: Paginated list of users
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LookupPagedResponse'
 *             example:
 *               data:
 *                 - username: alice*localhost
 *                   address: GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ
 *                   created_at: '2024-01-15T10:30:00.000Z'
 *               totalCount: 1
 *               totalPages: 1
 *               currentPage: 1
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.get('/users', async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const search = typeof req.query.search === 'string' ? req.query.search : null;
app.get('/users', validateSchema({ query: usersQuerySchema }), async (req, res, next) => {
  const { page, limit, search = null } = req.query;
  const skip = (page - 1) * limit;

  const where = search
    ? {
        deletedAt: null,
        OR: [
          { username: { contains: search, mode: 'insensitive' } },
          { address: { contains: search, mode: 'insensitive' } },
        ],
      }
    : { deletedAt: null };

  try {
    const [totalCount, rows] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const totalPages = Math.ceil(totalCount / limit);
    const data = rows.map((user) => ({
      username: user.username,
      address: user.address,
      created_at: user.createdAt ? user.createdAt.toISOString() : undefined,
    }));

    res.json({
      data,
      meta: {
        total: totalCount,
        totalCount,
        page,
        currentPage: page,
        limit,
        totalPages,
      },
      totalCount,
      totalPages,
      currentPage: page,
    });
  } catch (error) {
    const dbError = new Error('Database error', { cause: error });
    dbError.statusCode = 500;
    return next(dbError);
  }
});
// Mount v1 router for both legacy paths and explicit API versioning
app.use('/', v1Router);
app.use('/api/v1', v1Router);
// Auth endpoints (email OTP verification) - uses Redis when available
app.use('/auth', require('./src/routes/v1/authRoutes')(redisClient));

app.get('/.well-known/stellar.toml', (_req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.setHeader('Content-Type', 'text/plain');
  res.send(`FEDERATION_SERVER="${process.env.FEDERATION_SERVER_URL || `https://${process.env.STELLAR_TAG_DOMAIN}/federation`}"\n`);
});

app.get('/api/v1/time', (_req, res) => {
  res.status(200).json({ time: new Date().toISOString() });
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Server health check
 *     description: Returns status "ok" when the server is running. Useful for uptime monitoring and load-balancer health probes.
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 *             example:
 *               status: ok
 */
app.get('/health', async (_req, res) => {
  const checks = { database: null, redis: null };
  let allOk = true;
  const errors = [];

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
    allOk = false;
    errors.push('Database unavailable');
  }

  if (redisClient) {
    try {
      await redisClient.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'error';
      allOk = false;
      errors.push('Redis unavailable');
    }
  } else {
    checks.redis = 'not configured';
  }

  if (allOk) {
    res.json({ status: 'ok', ...checks });
  } else {
    res.status(503).json({ status: 'error', ...checks, message: errors.join(', ') });
  }
});

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    logger.error(`[Correlation ID: ${req.correlationId}] Database unavailable`, err);
    res.status(503).json({ status: 'error', database: 'disconnected', correlation_id: req.correlationId });

  }
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

const gracefulShutdown = (server, prismaClient, signal) => {
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
      logger.error('Error disconnecting Prisma during shutdown:', err);
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
      logger.error(`Port ${PORT} is in use, forcing shutdown so Railway can restart cleanly.`);
      process.exit(1);
    }
  });

  process.on('SIGTERM', (sig) => gracefulShutdown(server, prisma, sig));
  process.on('SIGINT', (sig) => gracefulShutdown(server, prisma, sig));
}

module.exports = { app, gracefulShutdown, rejectNestedObjects, validateMemo };

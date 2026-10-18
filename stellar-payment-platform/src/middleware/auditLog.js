'use strict';

/**
 * src/middleware/auditLog.js
 *
 * Middleware to intercept mutating requests (POST, PUT, DELETE, PATCH)
 * and asynchronously record audit logs in the database.
 */

const { logger } = require('../logger');

const SENSITIVE_KEYS = [
  'password',
  'pass',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'signature',
  'privatekey',
  'private_key',
  'seed',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
];

const SENSITIVE_REGEX = new RegExp(
  `^(${SENSITIVE_KEYS.join('|')})$`,
  'i',
);

/**
 * Deeply redacts sensitive fields from objects or arrays.
 *
 * @param {*} data
 * @returns {*} Redacted clone of data.
 */
const redactSensitiveData = (data) => {
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(redactSensitiveData(parsed));
      }
    } catch {
      // not JSON string, return as is
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }

  if (typeof data === 'object') {
    const redacted = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_REGEX.test(key)) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = redactSensitiveData(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  return data;
};

/**
 * Extracts the user/admin ID from the request.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
const extractUserId = (req) => {
  if (req.user?.id) return String(req.user.id);
  if (req.user?.username) return String(req.user.username);
  if (req.headers['x-user-id']) return String(req.headers['x-user-id']);
  if (req.headers['x-admin-id']) return String(req.headers['x-admin-id']);
  if (req.headers['x-api-key'] || req.query?.api_key) return 'admin';
  return 'anonymous';
};

/**
 * Extracts client IP address safely.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
const extractIpAddress = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded[0];
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

/**
 * Creates Express middleware for audit logging mutating requests.
 *
 * @param {object} [opts]
 * @param {object} [opts.prismaClient] - Prisma client instance (defaults to shared prisma).
 * @param {Array<string>} [opts.methods=['POST', 'PUT', 'DELETE', 'PATCH']] - Methods to audit.
 * @returns {import('express').RequestHandler}
 */
const createAuditLogMiddleware = (opts = {}) => {
  const targetMethods = new Set(
    (opts.methods || ['POST', 'PUT', 'DELETE', 'PATCH']).map((m) => m.toUpperCase()),
  );

  return (req, res, next) => {
    if (!targetMethods.has(req.method.toUpperCase())) {
      return next();
    }

    const prisma = opts.prismaClient || require('../../prismaClient').prisma;
    const ipAddress = extractIpAddress(req);
    const userId = extractUserId(req);
    const method = req.method.toUpperCase();
    const path = req.originalUrl || req.url || req.path;
    const action = `${method} ${req.baseUrl || ''}${req.path || ''}`.trim() || `${method} ${path}`;
    const userAgent = req.headers['user-agent'] || null;

    // Snapshot redacted body at request time
    let redactedPayload = null;
    try {
      if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        redactedPayload = JSON.stringify(redactSensitiveData(req.body));
      }
    } catch (err) {
      logger.warn(`[auditLog] Failed to serialize request body: ${err.message}`);
    }

    // Intercept response finish asynchronously
    res.on('finish', () => {
      // Async write to database — must never block or crash
      setImmediate(async () => {
        try {
          if (prisma?.auditLog?.create) {
            await prisma.auditLog.create({
              data: {
                action,
                method,
                path,
                userId,
                ipAddress,
                userAgent,
                statusCode: res.statusCode,
                payload: redactedPayload,
              },
            });
          }
        } catch (err) {
          logger.error(`[auditLog] Failed to persist audit log for ${action}:`, err);
        }
      });
    });

    return next();
  };
};

const auditLogMiddleware = createAuditLogMiddleware();

module.exports = {
  createAuditLogMiddleware,
  auditLogMiddleware,
  redactSensitiveData,
  extractUserId,
  extractIpAddress,
};

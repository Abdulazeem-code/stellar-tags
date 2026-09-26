'use strict';

const crypto = require('crypto');
const { logger } = require('../logger');
const { ApiError, codeForStatus, errorBody, DEFAULT_MESSAGES } = require('../errors');

/**
 * Maps errors thrown by libraries, which carry their own conventions rather
 * than a code, onto the platform's codes.
 */
const classify = (err, req, isPrismaConnectionError) => {
  if (err instanceof ApiError) {
    return {
      code: err.code,
      statusCode: err.statusCode,
      message: err.message,
      details: err.details,
      expected: true,
    };
  }

  if (isPrismaConnectionError(err)) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      message: DEFAULT_MESSAGES.SERVICE_UNAVAILABLE,
      expected: true,
    };
  }

  // body-parser rejects oversized payloads with its own type tag.
  if (err.type === 'entity.too.large') {
    const bytes = req && req.bodySizeLimit;
    const maxKb = bytes ? Math.round(bytes / 1024) : 10;
    return {
      code: 'PAYLOAD_TOO_LARGE',
      statusCode: 413,
      message: `Payload too large. Maximum allowed size for this endpoint is ${maxKb}kb.`,
    };
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return { code: 'INVALID_INPUT', statusCode: 400, message: 'Malformed JSON payload' };
  }

  const statusCode = err.statusCode || err.status || 500;
  return {
    code: err.code && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)
      ? err.code
      : codeForStatus(statusCode),
    statusCode,
    message: err.message || DEFAULT_MESSAGES.INTERNAL_ERROR,
    details: err.details,
  };
};

/**
 * Terminal error handler: the single place an error becomes a response.
 *
 * Every failure leaves as
 * `{ success: false, error: { code, message, details? } }`, plus the
 * correlation id and, for 5xx, a reference id that ties the response to the
 * logged stack.
 *
 * A 5xx raised by an unexpected throw reports the generic message so internals
 * are never leaked, with the detail kept in the log under the reference id. A
 * message an author chose deliberately via ApiError is sent as written.
 */
const buildErrorHandler = (isPrismaConnectionError) =>
  // eslint-disable-next-line no-unused-vars
  (err, req, res, _next) => {
    const { code, statusCode, message, details, expected } = classify(err, req, isPrismaConnectionError);

    if (res.headersSent) {
      return;
    }

    if (statusCode >= 500) {
      const referenceId = crypto.randomUUID();
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[Correlation ID: ${req.correlationId}] [Error ID: ${referenceId}]`, err);
      }
      logger.error(`[Correlation ID: ${req.correlationId}] [Error ID: ${referenceId}]`, err);

      return res.status(statusCode).json(
        errorBody(code, expected ? message : DEFAULT_MESSAGES.INTERNAL_ERROR, {
          correlationId: req.correlationId,
          referenceId,
        }),
      );
    }

    return res.status(statusCode).json(
      errorBody(code, message, { details, correlationId: req.correlationId }),
    );
  };

/** Terminal 404 for unmatched routes, so misses use the same envelope. */
const notFoundHandler = (req, res) =>
  res.status(404).json(
    errorBody('NOT_FOUND', `Cannot ${req.method} ${req.path}`, {
      correlationId: req.correlationId,
    }),
  );

module.exports = { buildErrorHandler, notFoundHandler, classify };

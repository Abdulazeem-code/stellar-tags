'use strict';

const express = require('express');

/**
 * #588 — Per-route request body size limits.
 *
 * A single global JSON parser enforces a cap that depends on the endpoint
 * type, so the cap travels with the request regardless of mount point:
 *
 *   - Auth / register endpoints: 1kb  (tighter, to blunt abuse)
 *   - Bulk endpoints (/payments, /webhooks): 100kb (legitimate large payloads)
 *   - Everything else: 10kb (standard)
 *
 * body-parser already answers an oversized payload with a 413
 * (`entity.too.large`), which the error handler turns into the standard
 * envelope. The resolved byte limit is stashed on `req.bodySizeLimit` so the
 * 413 message can name the exact cap that was exceeded.
 *
 * NOTE: the installed raw-body only honours numeric / string `limit` values
 * (not a per-request function), so we dispatch to one of three pre-built
 * parsers based on the request path instead of using limit-as-a-function.
 */

const KB = 1024;

const AUTH_LIMIT = 1 * KB;
const STANDARD_LIMIT = 10 * KB;
const BULK_LIMIT = 100 * KB;

// Per-route tiers are intentionally explicit so the mapping is easy to audit
// and extend. Matched against the path portion of the request URL (no query).
const AUTH_PATTERNS = [
  /^\/register(\/|$)/i,
  /^\/auth(\/|$)/i,
];

const BULK_PATTERNS = [
  /\/payments(\/|$)/i,
  /\/webhooks(\/|$)/i,
];

/**
 * Resolve the byte limit for a request based on its path.
 *
 * @param {string} url full request URL (req.originalUrl)
 * @returns {number} maximum body size in bytes
 */
const limitForPath = (url) => {
  const path = (url || '').split('?')[0];

  if (AUTH_PATTERNS.some((re) => re.test(path))) {
    return AUTH_LIMIT;
  }
  if (BULK_PATTERNS.some((re) => re.test(path))) {
    return BULK_LIMIT;
  }
  return STANDARD_LIMIT;
};

// Pre-built parsers — each carries an explicit numeric limit that raw-body can
// enforce. The dispatcher below picks the right one per request.
const authParser = express.json({ limit: AUTH_LIMIT });
const standardParser = express.json({ limit: STANDARD_LIMIT });
const bulkParser = express.json({ limit: BULK_LIMIT });

/**
 * Express middleware that applies the per-route body size limit. It forwards to
 * the appropriate pre-built JSON parser for the request path, recording the
 * resolved cap on `req.bodySizeLimit` for downstream error reporting.
 */
const bodySizeLimit = (req, res, next) => {
  const bytes = limitForPath(req.originalUrl);
  req.bodySizeLimit = bytes;

  const parser =
    bytes === AUTH_LIMIT ? authParser
      : bytes === BULK_LIMIT ? bulkParser
        : standardParser;

  return parser(req, res, next);
};

module.exports = {
  KB,
  AUTH_LIMIT,
  STANDARD_LIMIT,
  BULK_LIMIT,
  limitForPath,
  bodySizeLimit,
};

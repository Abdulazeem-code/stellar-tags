'use strict';

/**
 * src/middleware/deprecation.js
 *
 * Express middleware implementing the Deprecation and Sunset HTTP headers
 * described in RFC 8594. Endpoints listed in the deprecation registry
 * (src/config/deprecations.js) receive the following response headers:
 *
 *   Deprecation  - HTTP-date the endpoint became deprecated (or "true").
 *   Sunset       - HTTP-date the endpoint is scheduled for removal.
 *   Link         - rel="deprecation" pointing at migration documentation.
 *   Warning      - 299 stale/deprecation notice for older clients.
 *
 * Every matched request also emits a server-side warning so operators can
 * track consumer reliance on soon-to-be-removed endpoints.
 */

const { logger } = require('../logger');
const { DEPRECATIONS } = require('../config/deprecations');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Returns true when the registered path pattern matches the request path.
 * A single '*' wildcard matches any trailing segment(s).
 *
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
const pathMatches = (pattern, path) => {
  if (pattern === path) return true;
  if (pattern.includes('*')) {
    const regex = new RegExp(
      `^${pattern.split('*').map(escapeRegExp).join('.*')}$`,
    );
    return regex.test(path);
  }
  return false;
};

/**
 * Locates a deprecation entry for the given method + path.
 *
 * @param {string} method HTTP method (any case).
 * @param {string} path Request path.
 * @returns {object|null} Matching registry entry or null.
 */
const findDeprecation = (method, path, registry = DEPRECATIONS) => {
  const verb = String(method || '').toUpperCase();
  for (const entry of registry) {
    const entryMethod = String(entry.method || '*').toUpperCase();
    if (entryMethod !== '*' && entryMethod !== verb) continue;
    if (pathMatches(entry.path, path)) return entry;
  }
  return null;
};

/**
 * Formats an ISO-8601 date as an RFC 7231 HTTP-date.
 *
 * @param {string} iso
 * @returns {string|null}
 */
const toHttpDate = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toUTCString();
};

// Throttles the server-side warning so each deprecated endpoint is logged
// at most once per process, avoiding log floods from high-traffic routes.
const loggedKeys = new Set();

const resetDeprecationLogger = () => loggedKeys.clear();

/**
 * Express middleware factory.
 *
 * @param {object} [options]
 * @param {Array} [options.registry] Override the deprecation registry
 *        (primarily used by tests).
 * @returns {Function} Express middleware.
 */
const deprecationMiddleware = (options = {}) => {
  const registry = options.registry || DEPRECATIONS;

  return (req, res, next) => {
    const entry = findDeprecation(req.method, req.path, registry);
    if (!entry) return next();

    const deprecatedSince = toHttpDate(entry.deprecatedSince) || 'true';
    const sunset = toHttpDate(entry.sunset);

    res.set('Deprecation', deprecatedSince);
    if (sunset) res.set('Sunset', sunset);

    if (entry.documentation) {
      res.set(
        'Link',
        `<${entry.documentation}>; rel="deprecation"`,
      );
    }

    if (sunset) {
      const message = entry.replacement
        ? `Deprecated endpoint ${req.method} ${req.path} will be removed after ${sunset}; migrate to ${entry.replacement}.`
        : `Deprecated endpoint ${req.method} ${req.path} will be removed after ${sunset}.`;
      res.set('Warning', `299 - "Deprecated API endpoint, scheduled for removal ${sunset}"`);

      const key = `${req.method} ${req.path}`;
      if (!loggedKeys.has(key)) {
        loggedKeys.add(key);
        logger.warn(
          {
            type: 'deprecation',
            method: req.method,
            path: req.path,
            sunset,
            replacement: entry.replacement || null,
            documentation: entry.documentation || null,
          },
          message,
        );
      }
    }

    return next();
  };
};

module.exports = {
  deprecationMiddleware,
  findDeprecation,
  pathMatches,
  toHttpDate,
  resetDeprecationLogger,
};

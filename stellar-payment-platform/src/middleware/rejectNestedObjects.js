'use strict';

/**
 * Flat-input guard.
 *
 * Most endpoints take a flat object of primitives, so a nested object or array
 * in the query string or the body means the caller sent something the endpoint
 * will not interpret. Rejecting it early turns a confusing "field is undefined"
 * into a clear 400.
 *
 * #685 — the GraphQL endpoint is exempt. `variables` is a nested object by
 * design and the schema validates the shape of everything inside it, so
 * enforcing flatness there would break every query that uses variables while
 * adding nothing. Exemptions are listed explicitly rather than being inferred,
 * so the list stays auditable.
 */

const { errorBody } = require('../errors');

const isPrimitive = (value) =>
  value === null || value === undefined || typeof value !== 'object';

const NESTED_OBJECT_EXEMPT_PATHS = [/^\/graphql(\/|$)/];

/** @param {import('express').Request} req */
const allowsNestedObjects = (req) => {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return NESTED_OBJECT_EXEMPT_PATHS.some((pattern) => pattern.test(path));
};

/**
 * Express middleware enforcing the flat-input rule.
 *
 * Responds directly rather than delegating, so the middleware stays usable on
 * its own — the same way validateSchema behaves.
 */
const rejectNestedObjects = (req, res, next) => {
  if (allowsNestedObjects(req)) {
    return next();
  }

  const sources = [req.query, req.body];
  for (const source of sources) {
    if (source && typeof source === 'object') {
      for (const value of Object.values(source)) {
        if (!isPrimitive(value)) {
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

  return next();
};

module.exports = {
  isPrimitive,
  allowsNestedObjects,
  rejectNestedObjects,
  NESTED_OBJECT_EXEMPT_PATHS,
};

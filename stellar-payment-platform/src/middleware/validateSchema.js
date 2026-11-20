'use strict';

const { errorBody } = require('../errors');

// An invalid body is a well-formed request carrying unprocessable content, so
// it answers 422 with VALIDATION_FAILED. A malformed query string is a bad
// request and answers 400 with INVALID_INPUT.
const BODY_STATUS = 422;
const REQUEST_STATUS = 400;
const BODY_CODE = 'VALIDATION_FAILED';
const REQUEST_CODE = 'INVALID_INPUT';

const formatIssues = (issues) =>
  issues.map((issue) => ({
    field: issue.path.length ? issue.path.join('.') : '_root',
    message: issue.message,
  }));

/**
 * Builds middleware that validates the request body and query string against
 * zod schemas before the route handler runs.
 *
 * Each validated part is replaced with the parsed result, so handlers receive
 * values that are already trimmed, coerced and known-shaped and never have to
 * re-check types themselves.
 *
 * @param {{ body?: import('zod').ZodType, query?: import('zod').ZodType }} schemas
 */
function validateSchema({ body, query } = {}) {
  const targets = [
    { key: 'body', schema: body, status: BODY_STATUS, code: BODY_CODE },
    { key: 'query', schema: query, status: REQUEST_STATUS, code: REQUEST_CODE },
  ].filter((target) => target.schema);

  return (req, res, next) => {
    for (const { key, schema, status, code } of targets) {
      const result = schema.safeParse(req[key] ?? {});

      if (!result.success) {
        return res.status(status).json(
          errorBody(code, `Invalid request ${key}`, {
            details: formatIssues(result.error.issues),
            correlationId: req.correlationId,
          }),
        );
      }

      req[key] = result.data;
    }

    return next();
  };
}

module.exports = { validateSchema, BODY_STATUS, REQUEST_STATUS, BODY_CODE, REQUEST_CODE };

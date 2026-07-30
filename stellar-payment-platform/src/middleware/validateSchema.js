'use strict';

// An invalid body is a well-formed request carrying unprocessable content, so
// it answers 422. A malformed query string or path parameter is a bad request
// and answers 400. Both use the same error shape.
const BODY_STATUS = 422;
const REQUEST_STATUS = 400;

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
    { key: 'body', schema: body, status: BODY_STATUS },
    { key: 'query', schema: query, status: REQUEST_STATUS },
  ].filter((target) => target.schema);

  return (req, res, next) => {
    for (const { key, schema, status } of targets) {
      const result = schema.safeParse(req[key] ?? {});

      if (!result.success) {
        return res.status(status).json({
          success: false,
          errors: formatIssues(result.error.issues),
        });
      }

      req[key] = result.data;
    }

    return next();
  };
}

module.exports = { validateSchema, BODY_STATUS, REQUEST_STATUS };

const { validationResult } = require('express-validator');

/**
 * Middleware that checks for validation errors from express-validator chains.
 * Must be used AFTER the validation chain array in the route definition.
 * Returns 422 with structured errors if validation fails.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      errors: errors.array().map(err => ({
        field: err.path,
        message: err.msg,
      })),
    });
  }
  next();
}

module.exports = { validate };

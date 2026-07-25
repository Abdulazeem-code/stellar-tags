const { body } = require('express-validator');

/**
 * Validation chain for the /register endpoint.
 *
 * Rules:
 * - username: required, 3-20 chars, alphanumeric only
 * - address: required, non-empty string
 */
const registerValidator = [
  body('username')
    .exists({ checkFalsy: true })
    .withMessage('username is required')
    .isLength({ min: 3, max: 20 })
    .withMessage('username must be between 3 and 20 characters')
    .isAlphanumeric()
    .withMessage('username must contain only letters and numbers')
    .trim(),
  body('address')
    .exists({ checkFalsy: true })
    .withMessage('address is required')
    .isString()
    .withMessage('address must be a string')
    .notEmpty()
    .withMessage('address cannot be empty')
    .trim(),
];

module.exports = { registerValidator };

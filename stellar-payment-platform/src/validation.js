'use strict';

const { z } = require('zod');

/**
 * Zod schema for POST /register request body.
 *
 * Rules:
 *  - username: alphanumeric characters only, 3–20 characters long.
 *              The federation suffix (*localhost) is appended by the server
 *              after validation, so we validate the bare username here.
 *  - address:  must be a valid Stellar public key — Ed25519 keys always start
 *              with the letter "G" and are 56 characters long (Stellar base32).
 */
const registerSchema = z.object({
  username: z
    .string({ required_error: 'username is required' })
    .min(3, 'username must be at least 3 characters')
    .max(20, 'username must be at most 20 characters')
    .regex(/^[a-zA-Z0-9]+$/, 'username must contain only alphanumeric characters'),

  address: z
    .string({ required_error: 'address is required' })
    .regex(
      /^G[A-Z2-7]{55}$/,
      'address must be a valid Stellar public key (starts with G, 56 characters)',
    ),
});

/**
 * Express middleware that validates req.body against registerSchema.
 * On failure it responds with 400 and a structured errors array so
 * callers can see exactly which fields are invalid.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const validateRegister = (req, res, next) => {
  const result = registerSchema.safeParse(req.body);

  if (!result.success) {
    const errors = result.error.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    return res.status(400).json({ error: 'Validation failed', errors });
  }

  // Attach the parsed (and type-safe) data back onto req.body so downstream
  // handlers always work with validated values.
  req.body = result.data;
  return next();
};

module.exports = { registerSchema, validateRegister };

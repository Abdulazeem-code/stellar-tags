'use strict';

const { z } = require('zod');

/**
 * Body accepted by SEP-10 `POST /auth`.
 *
 * Express has already parsed either `application/json` or
 * `application/x-www-form-urlencoded` into `req.body`; both produce the same
 * single `transaction` string field.
 */
const sep10TokenBodySchema = z
  .object({
    transaction: z
      .string({ error: 'transaction is required' })
      .trim()
      .min(1, 'transaction is required'),
  })
  .loose();

module.exports = { sep10TokenBodySchema };

'use strict';

const { z } = require('zod');
const { sanitized } = require('./index');

const MAX_METADATA_BYTES = 2 * 1024;

const metadataSchema = z
  .record(z.string(), z.json())
  .refine(
    (metadata) => Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= MAX_METADATA_BYTES,
    { message: 'metadata must not exceed 2KB' },
  );

const paymentIntentSchema = z.object({
  // Free-text identifier supplied by the caller — sanitize before storage.
  external_id: sanitized(z.string().trim()).optional(),
  // Stellar addresses and amounts are structurally constrained by the handler
  // (StrKey / numeric checks), so they don't need HTML sanitization here.
  from: z.string({ error: 'from address is required' }).trim().min(1),
  to: z.string({ error: 'to address is required' }).trim().min(1),
  amount: z.string({ error: 'amount is required' }).trim().min(1),
  asset: z.string().trim().optional(),
  // Memo fields are free text that may be stored and rendered in the dashboard.
  memo_type: sanitized(z.string().trim()).optional(),
  memo: sanitized(z.string().trim()).optional(),
  metadata: metadataSchema.optional(),
});

const bulkPaymentSchema = z.array(paymentIntentSchema).min(1).max(1000);

module.exports = {
  paymentIntentSchema,
  bulkPaymentSchema,
  metadataSchema,
  MAX_METADATA_BYTES,
};

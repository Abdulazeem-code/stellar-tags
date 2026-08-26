const { z } = require('zod');

const MAX_METADATA_BYTES = 2 * 1024;

const metadataSchema = z
  .record(z.string(), z.json())
  .refine(
    (metadata) => Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= MAX_METADATA_BYTES,
    { message: 'metadata must not exceed 2KB' },
  );

const paymentIntentSchema = z.object({
  external_id: z.string().trim().optional(),
  from: z.string({ error: 'from address is required' }).trim().min(1),
  to: z.string({ error: 'to address is required' }).trim().min(1),
  amount: z.string({ error: 'amount is required' }).trim().min(1),
  asset: z.string().trim().optional(),
  memo_type: z.string().trim().optional(),
  memo: z.string().trim().optional(),
  metadata: metadataSchema.optional(),
});

const bulkPaymentSchema = z.array(paymentIntentSchema).min(1).max(1000);

module.exports = {
  paymentIntentSchema,
  bulkPaymentSchema,
  metadataSchema,
  MAX_METADATA_BYTES,
};

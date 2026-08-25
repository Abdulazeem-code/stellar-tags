const { z } = require('zod');

const paymentIntentSchema = z.object({
  external_id: z.string().trim().optional(),
  from: z.string({ error: 'from address is required' }).trim().min(1),
  to: z.string({ error: 'to address is required' }).trim().min(1),
  amount: z.string({ error: 'amount is required' }).trim().min(1),
  asset: z.string().trim().optional(),
  memo_type: z.string().trim().optional(),
  memo: z.string().trim().optional(),
});

const bulkPaymentSchema = z.array(paymentIntentSchema).min(1).max(1000);

module.exports = { paymentIntentSchema, bulkPaymentSchema };

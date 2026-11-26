'use strict';

const { z } = require('zod');

/**
 * Query schema for SEP-10 `GET /auth`.
 *
 * This layer only checks shapes. StrKey checksum validation happens in the
 * service so the SDK stays lazily loaded when SEP-10 is disabled.
 */

const MAX_MEMO_ID = 18446744073709551615n;

const bareHostname = z
  .string()
  .trim()
  .min(1, 'must be a non-empty hostname')
  .max(253, 'must be at most 253 characters')
  .regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/,
    'must be a bare hostname without scheme, path, port or whitespace',
  );

const sep10Account = z
  .string({ error: 'account is required' })
  .trim()
  .regex(/^[GM][A-Z2-7]{55}$/, 'account must be a valid Stellar G... or M... address');

// SEP-10 only defines an ID memo. The SDK expects the uint64 as a string.
const sep10MemoId = z
  .string()
  .trim()
  .max(20, 'memo must fit in a uint64 ID memo')
  .regex(/^\d+$/, 'memo must be an ID memo (an unsigned integer)')
  .refine((value) => /^\d+$/.test(value) && BigInt(value) <= MAX_MEMO_ID, {
    error: 'memo must fit in a uint64 ID memo',
  });

const sep10ChallengeQuerySchema = z
  .object({
    account: sep10Account,
    memo: sep10MemoId.optional(),
    home_domain: bareHostname.optional(),
    // Full client-domain verification is a separate issue. Accept the parameter
    // so wallets can send it, but do not put it in the challenge transaction.
    client_domain: z.string().trim().optional(),
  })
  .loose();

module.exports = {
  sep10ChallengeQuerySchema,
  sep10Account,
  sep10MemoId,
  bareHostname,
  MAX_MEMO_ID,
};

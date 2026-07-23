const express = require('express');
const xss = require('xss');
const { StrKey } = require('@stellar/stellar-sdk');
const { prisma } = require('../../../prismaClient');
const { verifyMultiSignerThreshold } = require('../../multisigner-verifier');
const { normalizeNameTag, poolGet, poolRun, poolAll } = require('../../db');

const router = express.Router();

const VALID_MEMO_TYPES = ['text', 'id', 'hash'];
const MEMO_ID_RE = /^\d+$/;
const MEMO_HASH_RE = /^[0-9a-fA-F]{64}$/;

const validateMemo = (memoType, memo) => {
  if (!memoType && !memo) return null;
  if (memoType && !memo) return 'memo is required when memo_type is provided.';
  if (!memoType && memo) return 'memo_type is required when memo is provided.';
  if (!VALID_MEMO_TYPES.includes(memoType)) {
    return `memo_type must be one of: ${VALID_MEMO_TYPES.join(', ')}.`;
  }
  if (memoType === 'text' && Buffer.byteLength(memo, 'utf8') > 28) {
    return 'memo of type text must not exceed 28 bytes.';
  }
  if (memoType === 'id') {
    if (!MEMO_ID_RE.test(memo) || BigInt(memo) > 18446744073709551615n) {
      return 'memo of type id must be a valid 64-bit unsigned integer.';
    }
  }
  if (memoType === 'hash' && !MEMO_HASH_RE.test(memo)) {
    return 'memo of type hash must be a 64-character hex string (32 bytes).';
  }
  return null;
};

router.post('/register', async (req, res, next) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: "Unsupported Media Type. Please send application/json" });
  }
  const safeUsername = xss(req.body.username);
  const username = normalizeNameTag(safeUsername);
  const address = typeof req.body.address === 'string' ? req.body.address.trim() : '';
  const memoType = typeof req.body.memo_type === 'string' ? req.body.memo_type.trim() : undefined;
  const memo = typeof req.body.memo === 'string' ? req.body.memo.trim() : undefined;
  const signature = typeof req.body.signature === 'string' ? req.body.signature.trim() : '';

  if (address.toUpperCase().startsWith('S')) {
    return res.status(400).json({ error: "Never share your Secret Key. Please register using your Public Key (starts with G)." });
  }

  if (!username || !address) {
    return res.status(400).json({ error: 'Missing required fields: username and address are both required.' });
  }

  const usernameLocalPart = username.includes('*') ? username.split('*')[0] : username;
  if (usernameLocalPart.length < 3) {
    return res.status(400).json({ error: "Username must be at least 3 characters long." });
  }

  if (!StrKey.isValidEd25519PublicKey(address)) {
    const error = new Error('Invalid Stellar Public Key format.');
    error.statusCode = 400;
    return next(error);
  }

  const memoError = validateMemo(memoType, memo);
  if (memoError) {
    return res.status(400).json({ error: memoError });
  }

  if (signature && !StrKey.isValidEd25519PublicKey(signature)) {
    const error = new Error('Invalid Stellar Public Key format.');
    error.statusCode = 400;
    return next(error);
  }

  const normalizedUsername = username.toLowerCase();

  const RESERVED_NAMES = ['admin', 'root', 'support', 'system', 'stellar', 'api', 'help'];
  if (RESERVED_NAMES.includes(normalizedUsername)) {
    return res.status(403).json({ error: "This username is reserved and cannot be registered." });
  }

  try {
    const existing = await prisma.user.findFirst({
      where: { address, deletedAt: null },
    });

    if (existing) {
      const conflictError = new Error('Address already registered');
      conflictError.statusCode = 409;
      return next(conflictError);
    }

    let verificationResult = null;
    if (signature) {
      verificationResult = await verifyMultiSignerThreshold(address, [signature], {
        operationType: 'management',
      });

      if (!verificationResult.success) {
        const verificationError = new Error(
          verificationResult.errorMessage || 'Signature verification failed'
        );
        verificationError.statusCode = 401;
        throw verificationError;
      }
    }

    await prisma.user.create({
      data: {
        username: normalizedUsername,
        address,
        ...(memoType && { memoType, memo }),
      },
    });

    return res.status(201).json({
      ok: true,
      username: normalizedUsername,
      address,
      federation_address: `${normalizedUsername}*${process.env.DOMAIN || 'localhost'}`,
      ...(verificationResult && {
        verification: {
          accountId: verificationResult.accountId,
          signerCount: verificationResult.signerCount,
          thresholdMet: verificationResult.success,
          requiredThreshold: verificationResult.requiredThreshold,
          providedWeight: verificationResult.totalWeight,
        },
      }),
      ...(memoType && { memo_type: memoType, memo }),
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT' || (error.message && error.message.includes('UNIQUE'))) {
      return res.status(409).json({ error: 'Username is already taken. Please choose another.' });
    }
    
    if (error.message && error.message.includes('Account not found')) {
      const notFoundError = new Error(`Account not found on Horizon: ${address}`);
      notFoundError.statusCode = 404;
      return next(notFoundError);
    }

    if (error.statusCode === 401) {
      return next(error);
    }

    console.error('Registration error:', error.message);
    const registrationError = new Error(`Registration verification failed: ${error.message}`);
    registrationError.statusCode = 500;
    return next(registrationError);
  }
});

router.all('/register', (req, res) => res.status(405).json({ error: "Method Not Allowed" }));

// #18 — Soft-delete endpoint. Sets deleted_at to now() instead of running a
// hard DELETE so the row is preserved for historical auditing.
router.delete('/register/:username', async (req, res, next) => {
  const username = normalizeNameTag(
    typeof req.params.username === 'string' ? req.params.username.trim() : '',
  ).toLowerCase();

  if (!username) {
    const error = new Error('Missing username parameter');
    error.statusCode = 400;
    return next(error);
  }

  try {
    const existing = await prisma.user.findFirst({
      where: { username, deletedAt: null },
    });

    if (!existing) {
      const notFoundError = new Error('Username not found or already deleted');
      notFoundError.statusCode = 404;
      return next(notFoundError);
    }

    await prisma.user.update({
      where: { username },
      data: { deletedAt: new Date() },
    });

    return res.status(200).json({ ok: true, username, deleted: true });
  } catch {
    const dbError = new Error('Failed to unregister account');
    dbError.statusCode = 500;
    return next(dbError);
  }
});

router.get('/lookup', async (req, res, next) => {
  const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  if (!address && !search) {
    const error = new Error("Missing required parameter: provide 'address' for exact lookup or 'search' for paginated search");
    error.statusCode = 400;
    return next(error);
  }

  if (address) {
    try {
      const row = await prisma.user.findFirst({
        where: { address, deletedAt: null },
        select: { username: true },
      });

      if (!row) {
        const notFoundError = new Error('Username not found for this address');
        notFoundError.statusCode = 404;
        return next(notFoundError);
      }

      return res.json({ username: row.username, address });
    } catch {
      const dbError = new Error('Database lookup failed');
      dbError.statusCode = 500;
      return next(dbError);
    }
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;

  const where = {
    deletedAt: null,
    OR: [
      { username: { contains: search, mode: 'insensitive' } },
      { address: { contains: search, mode: 'insensitive' } },
    ],
  };

  try {
    const [totalCount, rows] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const totalPages = Math.ceil(totalCount / limit);
    const data = rows.map((user) => ({
      username: user.username,
      address: user.address,
      created_at: user.createdAt.toISOString(),
    }));

    return res.json({ data, totalCount, totalPages, currentPage: page });
  } catch {
    const dbError = new Error('Database lookup failed');
    dbError.statusCode = 500;
    return next(dbError);
  }
});

router.get('/users', async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const search = typeof req.query.search === 'string' ? req.query.search : null;
  const skip = (page - 1) * limit;

  const where = search
    ? {
        deletedAt: null,
        OR: [
          { username: { contains: search, mode: 'insensitive' } },
          { address: { contains: search, mode: 'insensitive' } },
        ],
      }
    : { deletedAt: null };

  try {
    const [totalCount, rows] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const totalPages = Math.ceil(totalCount / limit);
    const data = rows.map((user) => ({
      username: user.username,
      address: user.address,
      created_at: user.createdAt.toISOString(),
    }));

    res.json({ data, totalCount, totalPages, currentPage: page });
  } catch {
    const dbError = new Error('Database error');
    dbError.statusCode = 500;
    return next(dbError);
  }
});

module.exports = router;

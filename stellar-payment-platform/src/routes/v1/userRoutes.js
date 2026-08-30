const express = require('express');
const xss = require('xss');
const { StrKey } = require('@stellar/stellar-sdk');
const { prisma } = require('../../../prismaClient');
const { verifyMultiSignerThreshold } = require('../../multisigner-verifier');
const { poolGet, poolRun, poolAll } = require('../../db');
const { lookupCached, invalidateFederationCache } = require('../../cache');
const { parsePagination, paginatedResponse } = require('../../pagination');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { createSignatureRateLimiter } = require('../../middleware/signatureRateLimit');
const {
  normalizeNameTag,
  validateMemo,
  RESERVED_NAMES,
  shouldFallbackToLocalRegistry,
} = require('../../utils');

const router = express.Router();

const signatureRateLimiter = createSignatureRateLimiter();

const buildUserSearchWhere = (search) => {
  if (!search) return {};
  return {
    OR: [
      { username: { contains: search, mode: 'insensitive' } },
      { address: { contains: search, mode: 'insensitive' } },
    ],
  };
};

const serializeUser = (user) => ({
  username: user.username,
  address: user.address,
  created_at: user.createdAt ? user.createdAt.toISOString() : undefined,
});

const getLocalUserByAddress = async (address) =>
  poolGet(
    'SELECT username, address FROM username_registry WHERE address = ? LIMIT 1',
    [address],
  );

const getLocalUserByUsername = async (username) =>
  poolGet(
    'SELECT username, address FROM username_registry WHERE username = ? LIMIT 1',
    [username],
  );

const listLocalUsers = async (search, page, limit) => {
  const searchPattern = `%${search}%`;
  const skip = (page - 1) * limit;
  const rows = await poolAll(
    `SELECT username, address, created_at
     FROM username_registry
     WHERE username LIKE ? COLLATE NOCASE OR address LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [searchPattern, searchPattern, limit, skip],
  );

  const countRow = await poolGet(
    `SELECT COUNT(*) AS totalCount
     FROM username_registry
     WHERE username LIKE ? COLLATE NOCASE OR address LIKE ? COLLATE NOCASE`,
    [searchPattern, searchPattern],
  );

  const totalCount = Number(countRow?.totalCount || 0);
  return paginatedResponse(
    rows.map((user) => ({
      username: user.username,
      address: user.address,
      created_at: user.created_at,
    })),
    totalCount,
    { page, limit },
  );
};

const registerLocalUser = async ({ username, address }) => {
  const existingByAddress = await getLocalUserByAddress(address);
  if (existingByAddress) {
    const conflictError = new Error('Address already registered');
    conflictError.statusCode = 409;
    throw conflictError;
  }

  const existingByUsername = await getLocalUserByUsername(username);
  if (existingByUsername) {
    const conflictError = new Error('Username is already taken. Please choose another.');
    conflictError.statusCode = 409;
    throw conflictError;
  }

  await poolRun(
    `INSERT INTO username_registry (username, address, created_at)
     VALUES (?, ?, ?)`,
    [username, address, new Date().toISOString()],
  );
};

router.post('/register', signatureRateLimiter, asyncHandler(async (req, res, next) => {
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

  if (RESERVED_NAMES.includes(normalizedUsername)) {
    return res.status(403).json({ error: "This username is reserved and cannot be registered." });
  }

  try {
    const existing = await prisma.user.findUnique({
      where: { address }
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
    // Invalidate any stale federation cache entries for this username/address
    invalidateFederationCache(normalizedUsername, address);

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

    throw error;
  }
}));

router.all('/register', (req, res) => res.status(405).json({ error: "Method Not Allowed" }));

router.get('/lookup', asyncHandler(async (req, res, next) => {
  const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  if (!address && !search) {
    const error = new Error("Missing required parameter: provide 'address' for exact lookup or 'search' for paginated search");
    error.statusCode = 400;
    return next(error);
  }

  if (address) {
    const result = await lookupCached(address, async () => {
      const row = await prisma.user.findUnique({
        where: { address },
        select: { username: true },
      });
      return row ? { username: row.username, address } : null;
    });

    if (!result) {
      const notFoundError = new Error('Username not found for this address');
      notFoundError.statusCode = 404;
      return next(notFoundError);
    }

    return res.json(result);
  }

  const { page, limit, skip } = parsePagination(req.query);
  const where = buildUserSearchWhere(search);

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
}));

router.get('/users', asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const search = typeof req.query.search === 'string' ? req.query.search : null;
  const where = buildUserSearchWhere(search);

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
    created_at: user.createdAt ? user.createdAt.toISOString() : undefined,
  }));

  res.json({
    data,
    meta: {
      total: totalCount,
      totalCount,
      page,
      currentPage: page,
      limit,
      totalPages,
    },
    totalCount,
    totalPages,
    currentPage: page,
  });
}));

module.exports = router;

const express = require('express');
const xss = require('xss');
const { StrKey } = require('@stellar/stellar-sdk');
const { prisma } = require('../../../prismaClient');
const { verifyMultiSignerThreshold } = require('../../multisigner-verifier');
const { poolGet, poolRun, poolAll } = require('../../db');
const { logger } = require('../../logger');
const { lookupCached, invalidateFederationCache } = require('../../cache');
const {
  paginatedResponse,
  parsePagination,
  parseCursorQuery,
  keysetWhereDesc,
  paginateByKeyset,
  cursorPaginatedResponse,
} = require('../../pagination');
const { asyncHandler } = require('../../middleware/asyncHandler');
const {
  normalizeNameTag,
  validateMemo,
  RESERVED_NAMES,
  MAX_USERNAMES_PER_ADDRESS,
  PRIMARY_USERNAME_ORDER,
  shouldFallbackToLocalRegistry,
} = require('../../utils');
const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { requireJson } = require('../../middleware/requireJson');
const {
  registerBodySchema,
  federationQuerySchema,
  lookupQuerySchema,
  usersQuerySchema,
} = require('../../schemas');
const { registerUser } = require('../../services/registrationService');
const { lookupUser, listUsers } = require('../../services/userService');
  lookupQuerySchema,
  usersQuerySchema,
} = require('../../schemas');

const router = express.Router();

const buildUserSearchWhere = (search) => {
  if (!search) return {};
  return {
    deletedAt: null,
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

router.post('/register', requireJson, validateSchema({ body: registerBodySchema }), asyncHandler(async (req, res, next) => {
  try {
    const result = await registerUser(req.body);
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
}));

router.all('/register', (req, res, next) => next(new ApiError('METHOD_NOT_ALLOWED')));

// #18 — Soft-delete endpoint. Sets deleted_at to now() instead of running a
// hard DELETE so the row is preserved for historical auditing.
router.delete('/register/:username', asyncHandler(async (req, res, next) => {
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
    
    // Invalidate any stale federation cache entries
    invalidateFederationCache(username, existing.address);

    return res.status(200).json({ ok: true, username, deleted: true });
  } catch (error) {
    logger.error('Failed to unregister account:', error);
    const dbError = new Error('Failed to unregister account', { cause: error });
    dbError.statusCode = 500;
    return next(dbError);
  }
}));

router.get('/lookup', etagCache, validateSchema({ query: lookupQuerySchema }), asyncHandler(async (req, res, next) => {
  try {
    const result = await lookupUser(req.query.address, req.query.search, req.query);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}));

router.get('/users', etagCache, validateSchema({ query: usersQuerySchema }), asyncHandler(async (req, res, next) => {
  try {
    const result = await listUsers(req.query);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}));

module.exports = router;

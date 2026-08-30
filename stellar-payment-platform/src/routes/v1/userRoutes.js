const express = require('express');
const xss = require('xss');
const { StrKey } = require('@stellar/stellar-sdk');
const { prisma } = require('../../../prismaClient');
const { verifyMultiSignerThreshold } = require('../../multisigner-verifier');
const { poolGet, poolRun, poolAll, etagCache } = require('../../db');
const { logger } = require('../../logger');
const { transferAccount } = require('../../services/registrationService');
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
    'SELECT username, address FROM username_registry WHERE address = $1 LIMIT 1',
    [address],
  );

const getLocalUserByUsername = async (username) =>
  poolGet(
    'SELECT username, address FROM username_registry WHERE username = $1 LIMIT 1',
    [username],
  );

const listLocalUsers = async (search, page, limit) => {
  const searchPattern = `%${search}%`;
  const skip = (page - 1) * limit;
  const rows = await poolAll(
    `SELECT username, address, created_at
     FROM username_registry
     WHERE username ILIKE $1 OR address ILIKE $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [searchPattern, limit, skip],
  );

  const countRow = await poolGet(
    `SELECT COUNT(*) AS "totalCount"
     FROM username_registry
     WHERE username ILIKE $1 OR address ILIKE $1`,
    [searchPattern],
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
     VALUES ($1, $2, $3)`,
    [username, address, new Date().toISOString()],
  );
};

router.post('/register', requireJson, validateSchema({ body: registerBodySchema }), asyncHandler(async (req, res, next) => {
  try {
    const result = await registerUser(req.body);
    return res.status(201).json(result);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT' || error.code === 'P2002' || (error.message && error.message.includes('UNIQUE'))) {
      return next(new ApiError('CONFLICT', 'Username is already taken. Please choose another.'));
    }
    
    if (error.message && error.message.includes('Account not found')) {
      const notFoundError = new Error(`Account not found on Horizon: ${address}`);
      notFoundError.statusCode = 404;
      return next(notFoundError);
    }

    if (error.statusCode === 401) {
      return next(error);
    }

    logger.error('Registration error:', error.message);
    const registrationError = new Error(`Registration verification failed: ${error.message}`, { cause: error });
    registrationError.statusCode = 500;
    return next(registrationError);
  }
}));

router.post('/users/:username/transfer', async (req, res, next) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: "Unsupported Media Type. Please send application/json" });
  }

  const { username } = req.params;
  const { oldAddress, newAddress, oldSignature, newSignature } = req.body;

  try {
    const normalizedUsername = typeof username === 'string' ? username.toLowerCase().trim() : '';
    const updatedUser = await transferAccount(
      normalizedUsername,
      oldAddress,
      newAddress,
      oldSignature,
      newSignature
    );

    return res.status(200).json({
      ok: true,
      message: 'Account transferred successfully',
      username: updatedUser.username,
      new_address: updatedUser.address,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ error: error.message || 'Transfer failed' });
  }
});

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
  const { address = '', search = '' } = req.query;

  if (address) {
    try {
      const result = await lookupCached(address, async () => {
        // #613 — an address can have several usernames; return the primary.
        const row = await prisma.user.findFirst({
          where: { address, deletedAt: null },
          select: { username: true },
          orderBy: PRIMARY_USERNAME_ORDER,
        });
        return row ? { username: row.username, address } : null;
      });

      if (!result) {
        const notFoundError = new Error('Username not found for this address');
        notFoundError.statusCode = 404;
        return next(notFoundError);
      }

      return res.json(result);
    } catch (error) {
      console.warn('USER ROUTES ERROR:', error);
      const dbError = new Error('Database lookup failed', { cause: error });
      dbError.statusCode = 500;
      return next(dbError);
    }
  }

  const { limit: cursorLimit, cursor, invalid: invalidCursor } = parseCursorQuery(req.query);
  const { page, limit, skip } = parsePagination(req.query);
  if (invalidCursor) {
    return next(new ApiError('INVALID_INPUT', 'Invalid cursor parameter'));
  }
  const where = buildUserSearchWhere(search);

  try {
    const result = await lookupUser(req.query.address, req.query.search, req.query);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}));

router.get('/users', etagCache, validateSchema({ query: usersQuerySchema }), asyncHandler(async (req, res, next) => {
  const { limit: cursorLimit, cursor, invalid: invalidCursor } = parseCursorQuery(req.query);
  const { page, limit, skip } = parsePagination(req.query);
  if (invalidCursor) {
    return next(new ApiError('INVALID_INPUT', 'Invalid cursor parameter'));
  }
  const search = req.query.search ?? null;
  const where = search ? buildUserSearchWhere(search) : { deletedAt: null };

  try {
    const result = await listUsers(req.query);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}));

module.exports = router;

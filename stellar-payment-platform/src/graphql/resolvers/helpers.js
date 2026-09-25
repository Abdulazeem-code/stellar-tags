'use strict';

/**
 * #685 — Shared resolver helpers.
 *
 * Argument parsing, `where`-clause construction, and connection shaping. Kept
 * separate from the resolvers themselves so the pagination limits and the
 * normalisation rules stay in one place, and so they can be unit tested without
 * building a schema.
 */

const { normalizeNameTag } = require('../../utils');
const { parsePagination } = require('../../pagination');
const { ApiError } = require('../../errors');

/**
 * Usernames are stored as normalised name tags (`alice*example.com`), so every
 * lookup has to normalise the argument the same way registration did. Getting
 * this wrong turns "user not found" into a silent miss.
 */
const normalizeUsername = (value) => normalizeNameTag(value).toLowerCase();

/**
 * Page window for a connection. Reuses the REST layer's parser so `limit` is
 * capped identically on both surfaces.
 */
const paginationFromArgs = (pagination) =>
  parsePagination({
    page: pagination?.page,
    limit: pagination?.limit,
  });

/** Wrap rows in the `totalCount` / `totalPages` / `hasNextPage` envelope. */
const connection = (nodes, totalCount, { page, limit }) => {
  const totalPages = limit > 0 ? Math.ceil(totalCount / limit) : 0;
  return {
    nodes: nodes || [],
    totalCount,
    currentPage: page,
    totalPages,
    hasNextPage: page < totalPages,
  };
}

/**
 * Turn a `DateRange` input into a Prisma date filter. A bare `YYYY-MM-DD` bound
 * is widened to the whole UTC day, which is what a dashboard date picker means
 * and what the stats service already does.
 */
const dateBounds = (range) => {
  if (!range) return null;

  const bounds = {};

  if (range.startDate) {
    const start = new Date(range.startDate);
    if (Number.isNaN(start.getTime())) {
      throw new ApiError('INVALID_INPUT', 'Invalid startDate.');
    }
    start.setUTCHours(0, 0, 0, 0);
    bounds.gte = start;
  }

  if (range.endDate) {
    const end = new Date(range.endDate);
    if (Number.isNaN(end.getTime())) {
      throw new ApiError('INVALID_INPUT', 'Invalid endDate.');
    }
    end.setUTCHours(23, 59, 59, 999);
    bounds.lte = end;
  }

  if (bounds.gte && bounds.lte && bounds.gte > bounds.lte) {
    throw new ApiError('INVALID_INPUT', 'startDate must not be after endDate.');
  }

  return Object.keys(bounds).length > 0 ? bounds : null;
};

const isPresent = (value) => value !== undefined && value !== null;

/** Prisma `where` for `Query.users`. */
const buildUserWhere = (filter) => {
  const where = {};

  if (!filter?.includeDeleted) where.deletedAt = null;
  if (isPresent(filter?.address)) where.address = filter.address;
  if (isPresent(filter?.isPrimary)) where.isPrimary = filter.isPrimary;

  if (isPresent(filter?.flagged)) {
    where.flaggedAt = filter.flagged ? { not: null } : null;
  }

  if (filter?.search) {
    where.OR = [
      { username: { contains: filter.search, mode: 'insensitive' } },
      { address: { contains: filter.search, mode: 'insensitive' } },
    ];
  }

  return where;
};

/** Prisma `where` for `Query.payments`. */
const buildPaymentWhere = (filter) => {
  const where = {};

  if (filter?.fromAddress) where.fromAddress = filter.fromAddress;
  if (filter?.toAddress) where.toAddress = filter.toAddress;
  if (filter?.status) where.status = filter.status;
  if (filter?.assetCode) where.assetCode = filter.assetCode;

  if (isPresent(filter?.minAmount) || isPresent(filter?.maxAmount)) {
    where.amount = {
      ...(isPresent(filter?.minAmount) && { gte: filter.minAmount }),
      ...(isPresent(filter?.maxAmount) && { lte: filter.maxAmount }),
    };
  }

  const range = dateBounds(filter?.range);
  if (range) where.createdAt = range;

  return where;
};

/** Prisma `where` for `Query.paymentIntents`. */
const buildPaymentIntentWhere = (filter) => {
  const where = {};

  if (filter?.from) where.from = filter.from;
  if (filter?.to) where.to = filter.to;
  if (filter?.status) where.status = filter.status;
  if (filter?.externalId) where.externalId = filter.externalId;

  const range = dateBounds(filter?.range);
  if (range) where.createdAt = range;

  return where;
};

const direction = (value) => (String(value).toUpperCase() === 'ASC' ? 'asc' : 'desc');

/**
 * Prisma `orderBy` for `Query.users`. `username` is appended as a tie-breaker so
 * rows sharing a `createdAt` keep a stable position across pages.
 */
const buildUserOrderBy = (orderBy) => {
  const clauses = [];

  for (const entry of (orderBy || []).slice(0, 2)) {
    if (entry?.field === 'USERNAME') {
      clauses.push({ username: direction(entry.direction) });
    } else if (entry?.field === 'CREATED_AT') {
      clauses.push({ createdAt: direction(entry.direction) });
    }
  }

  if (clauses.length === 0) clauses.push({ createdAt: 'desc' });
  if (!clauses.some((clause) => 'username' in clause)) {
    clauses.push({ username: 'desc' });
  }

  return clauses;
};

/** Prisma `orderBy` for the payment listings. */
const buildPaymentOrderBy = (orderBy) => {
  const field = orderBy?.field;
  if (field === 'amount') return [{ amount: direction(orderBy.direction) }];
  if (field === 'id') return [{ id: direction(orderBy.direction) }];
  return [{ createdAt: direction(orderBy?.direction) }];
};

/** Rounds to 7 decimals, matching the precision the stats service reports. */
const roundAmount = (value) => Number((Number(value) || 0).toFixed(7));

module.exports = {
  normalizeUsername,
  paginationFromArgs,
  connection,
  dateBounds,
  buildUserWhere,
  buildPaymentWhere,
  buildPaymentIntentWhere,
  buildUserOrderBy,
  buildPaymentOrderBy,
  roundAmount,
  direction,
};

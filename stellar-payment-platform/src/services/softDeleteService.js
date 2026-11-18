'use strict';

/**
 * src/services/softDeleteService.js
 *
 * Soft-delete primitives for the platform's critical entities (#731): the
 * username registry (a.k.a. tags), payment records, and by extension every
 * read path built on them.
 *
 * Deleting never removes a row. It stamps `deletedAt`, so history survives,
 * foreign keys stay intact, and an operator can bring the record back through
 * the admin API. The exported predicates below are the single source of truth
 * for "is this row live": reads spread `ACTIVE_ONLY` into their `where`, and
 * the restore helpers spread `DELETED_ONLY`. The retention purge in
 * `src/soft-delete-purge-cron.js` is the only place that ever performs a hard
 * delete, and only after the retention window has elapsed.
 */

/** Predicate matching rows that are still live. */
const ACTIVE_ONLY = Object.freeze({ deletedAt: null });

/** Predicate matching rows that have been soft-deleted. */
const DELETED_ONLY = Object.freeze({ deletedAt: { not: null } });

const DEFAULT_DELETED_PAGE_SIZE = 50;
const MAX_DELETED_PAGE_SIZE = 200;

const clampTake = (take) => {
  const parsed = Number.parseInt(take, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DELETED_PAGE_SIZE;
  return Math.min(MAX_DELETED_PAGE_SIZE, parsed);
};

const clampSkip = (skip) => {
  const parsed = Number.parseInt(skip, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * Soft-deletes a username.
 *
 * @returns {Promise<boolean>} true when a live row was stamped; false when the
 *   username was unknown or had already been deleted.
 */
const softDeleteUser = async (prisma, username) => {
  const { count } = await prisma.user.updateMany({
    where: { username, ...ACTIVE_ONLY },
    data: { deletedAt: new Date() },
  });
  return count > 0;
};

/**
 * Restores a soft-deleted username by clearing its `deletedAt` stamp.
 *
 * @returns {Promise<boolean>} true when a deleted row was restored.
 */
const restoreUser = async (prisma, username) => {
  const { count } = await prisma.user.updateMany({
    where: { username, ...DELETED_ONLY },
    data: { deletedAt: null },
  });
  return count > 0;
};

/**
 * Soft-deletes a payment.
 *
 * @returns {Promise<boolean>} true when a live row was stamped.
 */
const softDeletePayment = async (prisma, id) => {
  const { count } = await prisma.payment.updateMany({
    where: { id, ...ACTIVE_ONLY },
    data: { deletedAt: new Date() },
  });
  return count > 0;
};

/**
 * Restores a soft-deleted payment by clearing its `deletedAt` stamp.
 *
 * @returns {Promise<boolean>} true when a deleted row was restored.
 */
const restorePayment = async (prisma, id) => {
  const { count } = await prisma.payment.updateMany({
    where: { id, ...DELETED_ONLY },
    data: { deletedAt: null },
  });
  return count > 0;
};

/** Looks up a soft-deleted username so the caller can invalidate its caches. */
const findDeletedUser = (prisma, username) =>
  prisma.user.findFirst({
    where: { username, ...DELETED_ONLY },
    select: { username: true, address: true, deletedAt: true },
  });

/** Looks up a soft-deleted payment, or null when it is live or unknown. */
const findDeletedPayment = (prisma, id) =>
  prisma.payment.findFirst({
    where: { id, ...DELETED_ONLY },
    select: {
      id: true,
      createdAt: true,
      fromAddress: true,
      toAddress: true,
      amount: true,
      status: true,
      deletedAt: true,
    },
  });

/** One page of soft-deleted usernames, newest deletion first. */
const listDeletedUsers = (prisma, { skip, take } = {}) =>
  prisma.user.findMany({
    where: { ...DELETED_ONLY },
    select: { username: true, address: true, deletedAt: true },
    orderBy: { deletedAt: 'desc' },
    skip: clampSkip(skip),
    take: clampTake(take),
  });

/** One page of soft-deleted payments, newest deletion first. */
const listDeletedPayments = (prisma, { skip, take } = {}) =>
  prisma.payment.findMany({
    where: { ...DELETED_ONLY },
    orderBy: { deletedAt: 'desc' },
    skip: clampSkip(skip),
    take: clampTake(take),
  });

module.exports = {
  ACTIVE_ONLY,
  DELETED_ONLY,
  DEFAULT_DELETED_PAGE_SIZE,
  MAX_DELETED_PAGE_SIZE,
  softDeleteUser,
  restoreUser,
  softDeletePayment,
  restorePayment,
  findDeletedUser,
  findDeletedPayment,
  listDeletedUsers,
  listDeletedPayments,
};

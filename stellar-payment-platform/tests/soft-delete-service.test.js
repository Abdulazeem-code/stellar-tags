'use strict';

/**
 * Unit tests for src/services/softDeleteService.js (#731).
 *
 * The service is the single place that decides which rows are live and which
 * have been deleted, so these tests pin the predicates and the update scopes
 * the admin routes rely on.
 */

const {
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
} = require('../src/services/softDeleteService');

const makePrisma = () => ({
  user: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
  },
  payment: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
  },
});

describe('softDeleteService predicates', () => {
  it('exposes the live and deleted predicates', () => {
    expect(ACTIVE_ONLY).toEqual({ deletedAt: null });
    expect(DELETED_ONLY).toEqual({ deletedAt: { not: null } });
  });
});

describe('user soft delete / restore', () => {
  let prisma;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('stamps deletedAt only on a live row', async () => {
    const result = await softDeleteUser(prisma, 'alice');

    expect(result).toBe(true);
    const [{ where, data }] = prisma.user.updateMany.mock.calls[0];
    expect(where).toEqual({ username: 'alice', deletedAt: null });
    expect(data.deletedAt).toBeInstanceOf(Date);
  });

  it('returns false when the username was unknown or already deleted', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    expect(await softDeleteUser(prisma, 'ghost')).toBe(false);
  });

  it('restores only a deleted row and clears the stamp', async () => {
    const result = await restoreUser(prisma, 'alice');

    expect(result).toBe(true);
    const [{ where, data }] = prisma.user.updateMany.mock.calls[0];
    expect(where).toEqual({ username: 'alice', deletedAt: { not: null } });
    expect(data).toEqual({ deletedAt: null });
  });

  it('returns false when the restore matched nothing', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    expect(await restoreUser(prisma, 'ghost')).toBe(false);
  });
});

describe('payment soft delete / restore', () => {
  let prisma;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('stamps deletedAt only on a live payment', async () => {
    const result = await softDeletePayment(prisma, 'pay-1');

    expect(result).toBe(true);
    const [{ where, data }] = prisma.payment.updateMany.mock.calls[0];
    expect(where).toEqual({ id: 'pay-1', deletedAt: null });
    expect(data.deletedAt).toBeInstanceOf(Date);
  });

  it('returns false when the payment was unknown or already deleted', async () => {
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    expect(await softDeletePayment(prisma, 'ghost')).toBe(false);
  });

  it('restores only a deleted payment and clears the stamp', async () => {
    const result = await restorePayment(prisma, 'pay-1');

    expect(result).toBe(true);
    const [{ where, data }] = prisma.payment.updateMany.mock.calls[0];
    expect(where).toEqual({ id: 'pay-1', deletedAt: { not: null } });
    expect(data).toEqual({ deletedAt: null });
  });

  it('returns false when the restore matched nothing', async () => {
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    expect(await restorePayment(prisma, 'ghost')).toBe(false);
  });
});

describe('deleted row lookups', () => {
  it('findDeletedUser scopes to deleted rows', async () => {
    const prisma = makePrisma();

    await findDeletedUser(prisma, 'alice');

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { username: 'alice', deletedAt: { not: null } },
      select: { username: true, address: true, deletedAt: true },
    });
  });

  it('findDeletedPayment scopes to deleted rows', async () => {
    const prisma = makePrisma();

    await findDeletedPayment(prisma, 'pay-1');

    const [{ where }] = prisma.payment.findFirst.mock.calls[0];
    expect(where).toEqual({ id: 'pay-1', deletedAt: { not: null } });
  });
});

describe('deleted row listings', () => {
  it('lists usernames newest deletion first and clamps the page', async () => {
    const prisma = makePrisma();

    await listDeletedUsers(prisma, { skip: -5, take: 9999 });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { deletedAt: { not: null } },
      select: { username: true, address: true, deletedAt: true },
      orderBy: { deletedAt: 'desc' },
      skip: 0,
      take: MAX_DELETED_PAGE_SIZE,
    });
  });

  it('falls back to the default page size when take is absent', async () => {
    const prisma = makePrisma();

    await listDeletedPayments(prisma, {});

    const [{ skip, take }] = prisma.payment.findMany.mock.calls[0];
    expect(skip).toBe(0);
    expect(take).toBe(DEFAULT_DELETED_PAGE_SIZE);
  });
});

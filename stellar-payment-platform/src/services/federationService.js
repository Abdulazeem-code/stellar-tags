'use strict';

const { prisma } = require('../../prismaClient');
const { USER_DATABASE, shouldFallbackToLocalRegistry, PRIMARY_USERNAME_ORDER } = require('../utils');
const { getLocalUserByAddress, getLocalUserByUsername } = require('./userService');

const resolveFederationId = async (queryValue) => {
  const row = await prisma.user.findFirst({
    where: { address: { equals: queryValue, mode: 'insensitive' }, deletedAt: null },
    select: { username: true, address: true, memoType: true, memo: true, flaggedAt: true },
    orderBy: PRIMARY_USERNAME_ORDER,
  });

  if (!row) return null;
  if (row.flaggedAt) {
    const forbiddenError = new Error('Address is blocked');
    forbiddenError.statusCode = 403;
    throw forbiddenError;
  }

  const response = {
    stellar_address: `${row.username}*${process.env.DOMAIN || 'localhost'}`,
    account_id: row.address,
  };
  if (row.memoType) {
    response.memo_type = row.memoType;
    response.memo = row.memo;
  }
  return response;
};

const resolveFederationName = async (queryName) => {
  let row;
  try {
    row = await prisma.user.findFirst({
      where: { username: queryName, deletedAt: null },
      select: { address: true, memoType: true, memo: true, flaggedAt: true },
    });

    if (row && row.flaggedAt) {
      const forbiddenError = new Error('Address is blocked');
      forbiddenError.statusCode = 403;
      throw forbiddenError;
    }
  } catch (error) {
    if (error.statusCode === 403) throw error;
    if (!shouldFallbackToLocalRegistry(error)) {
      throw error;
    }

    const localRow = await getLocalUserByUsername(queryName);
    row = localRow
      ? { address: localRow.address, memoType: null, memo: null }
      : null;
  }

  const address = row?.address || USER_DATABASE[queryName];
  if (!address) return null;

  const response = {
    stellar_address: address,
    account_id: address,
  };
  if (row?.memoType) {
    response.memo_type = row.memoType;
    response.memo = row.memo;
  }
  return response;
};

module.exports = {
  resolveFederationId,
  resolveFederationName,
};

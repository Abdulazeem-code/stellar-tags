'use strict';

const { prisma } = require('../../prismaClient');
const { USER_DATABASE, PRIMARY_USERNAME_ORDER, toFederationAddress } = require('../utils');

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
    stellar_address: toFederationAddress(row.username),
    account_id: row.address,
  };
  if (row.memoType) {
    response.memo_type = row.memoType;
    response.memo = row.memo;
  }
  return response;
};

const resolveFederationName = async (queryName) => {
  const row = await prisma.user.findFirst({
    where: { username: queryName, deletedAt: null },
    select: { username: true, address: true, memoType: true, memo: true, flaggedAt: true },
  });

  if (row && row.flaggedAt) {
    const forbiddenError = new Error('Address is blocked');
    forbiddenError.statusCode = 403;
    throw forbiddenError;
  }

  // A name lookup answers with the name it resolved, so `stellar_address` is
  // the federation address rather than the account id (SEP-0002). The
  // built-in registry is the exception: it maps a name straight to an address
  // and keeps no username to report.
  if (!row) {
    const legacyAddress = USER_DATABASE[queryName];
    if (!legacyAddress) return null;
    return {
      stellar_address: legacyAddress,
      account_id: legacyAddress,
    };
  }

  const response = {
    stellar_address: toFederationAddress(row.username),
    account_id: row.address,
  };
  if (row.memoType) {
    response.memo_type = row.memoType;
    response.memo = row.memo;
  }
  return response;
};

module.exports = {
  resolveFederationId,
  resolveFederationName,
};

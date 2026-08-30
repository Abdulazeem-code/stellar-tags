const crypto = require('crypto');
const { StrKey } = require('@stellar/stellar-sdk');
const { prisma } = require('../../prismaClient');
const { normalizeNameTag, validateMemo, RESERVED_NAMES } = require('../utils');
const { dateTime } = require('./schema');

const badInput = (message) => {
  const error = new Error(message);
  error.extensions = { code: 'BAD_USER_INPUT' };
  return error;
};

const requireUser = (context) => {
  if (!context.user) {
    const error = new Error('Authentication required');
    error.extensions = { code: 'UNAUTHENTICATED' };
    throw error;
  }
  return context.user;
};

const requireOwner = (context, username) => {
  const user = requireUser(context);
  if (context.auth?.role !== 'admin' && user.username !== username) {
    const error = new Error('You are not authorized to modify this user');
    error.extensions = { code: 'FORBIDDEN' };
    throw error;
  }
  return user;
};

const userWhere = ({ username, address } = {}) => {
  if (!username && !address) throw badInput('Provide a username or address');
  return { ...(username ? { username: normalizeNameTag(username).toLowerCase() } : {}), ...(address ? { address } : {}), deletedAt: null };
};

const resolvers = {
  DateTime: dateTime,
  User: {
    webhooks: (user) => prisma.webhook.findMany({ where: { username: user.username }, orderBy: { createdAt: 'desc' } }),
  },
  Query: {
    user: (_root, args) => prisma.user.findFirst({ where: userWhere(args) }),
    users: async (_root, { search, page = 1, limit = 25 }) => {
      if (page < 1 || limit < 1 || limit > 100) throw badInput('page must be positive and limit must be between 1 and 100');
      const where = {
        deletedAt: null,
        ...(search ? {
          OR: [
            { username: { contains: search, mode: 'insensitive' } },
            { address: { contains: search, mode: 'insensitive' } },
          ],
        } : {}),
      };
      const [totalCount, nodes] = await prisma.$transaction([
        prisma.user.count({ where }),
        prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      ]);
      return { nodes, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit) };
    },
    webhooks: async (_root, { username }, context) => {
      const user = requireUser(context);
      const requestedUsername = username ? normalizeNameTag(username).toLowerCase() : user.username;
      requireOwner(context, requestedUsername);
      return prisma.webhook.findMany({ where: { username: requestedUsername }, orderBy: { createdAt: 'desc' } });
    },
  },
  Mutation: {
    registerUser: async (_root, { input }) => {
      const username = normalizeNameTag(input.username).toLowerCase();
      if (RESERVED_NAMES.includes(username)) throw badInput('This username is reserved and cannot be registered');
      if (!StrKey.isValidEd25519PublicKey(input.address)) throw badInput('Invalid Stellar public key');
      const memoError = validateMemo(input.memoType, input.memo);
      if (memoError) throw badInput(memoError);
      try {
        return await prisma.user.create({
          data: {
            username,
            address: input.address,
            ...(input.memoType ? { memoType: input.memoType, memo: input.memo } : {}),
          },
        });
      } catch (error) {
        if (error.code === 'P2002' || /unique/i.test(error.message || '')) throw badInput('Username or address is already registered');
        throw error;
      }
    },
    deleteUser: async (_root, { username }, context) => {
      const normalizedUsername = normalizeNameTag(username).toLowerCase();
      requireOwner(context, normalizedUsername);
      const existing = await prisma.user.findFirst({ where: { username: normalizedUsername, deletedAt: null } });
      if (!existing) throw badInput('Username not found or already deleted');
      await prisma.user.update({ where: { username: normalizedUsername }, data: { deletedAt: new Date() } });
      return { success: true, username: normalizedUsername };
    },
    createWebhook: async (_root, { input }, context) => {
      const user = requireOwner(context, normalizeNameTag(input.username).toLowerCase());
      if (!/^https?:\/\/.{1,2040}$/i.test(input.url)) throw badInput('Webhook URL must use http or https');
      return prisma.webhook.create({
        data: {
          username: user.username,
          url: input.url,
          secret: crypto.randomBytes(32).toString('hex'),
        },
      });
    },
    deleteWebhook: async (_root, { id }, context) => {
      const user = requireUser(context);
      const result = await prisma.webhook.deleteMany({
        where: { id, ...(context.auth?.role === 'admin' ? {} : { username: user.username }) },
      });
      if (!result.count) throw badInput('Webhook not found');
      return { success: true };
    },
  },
};

module.exports = { resolvers };

'use strict';

const crypto = require('crypto');
const { GraphQLError, GraphQLScalarType, Kind } = require('graphql');
const { prisma } = require('../../prismaClient');

const parseDateTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid DateTime value');
  return date;
};

const dateTime = new GraphQLScalarType({
  name: 'DateTime',
  serialize: (value) => parseDateTime(value).toISOString(),
  parseValue: parseDateTime,
  parseLiteral(node) {
    if (node.kind !== Kind.STRING) throw new TypeError('DateTime must be an ISO string');
    return parseDateTime(node.value);
  },
});

const unauthenticated = () => {
  throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
};

const requireUser = (context, username) => {
  if (!context.user || (username && context.user.username !== username)) unauthenticated();
  return context.user;
};

const userWhere = (username) => ({ username, deletedAt: null });

const resolvers = {
  DateTime: dateTime,
  User: {
    webhooks: (user) => prisma.webhook.findMany({
      where: { username: user.username },
      orderBy: { createdAt: 'desc' },
    }),
  },
  Query: {
    user: (_parent, { username }) => prisma.user.findFirst({ where: userWhere(username) }),
    users: (_parent, { search, limit, offset }) => {
      const where = {
        deletedAt: null,
        ...(search ? {
          OR: [
            { username: { contains: search, mode: 'insensitive' } },
            { address: { contains: search, mode: 'insensitive' } },
          ],
        } : {}),
      };
      return prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: Math.max(0, offset),
        take: Math.min(100, Math.max(1, limit)),
      });
    },
    webhooks: (_parent, { username }, context) => {
      const owner = requireUser(context, username || context.user?.username);
      return prisma.webhook.findMany({
        where: { username: owner.username },
        orderBy: { createdAt: 'desc' },
      });
    },
  },
  Mutation: {
    registerUser: (_parent, { input }) => prisma.user.create({
      data: {
        username: String(input.username).trim().toLowerCase(),
        address: input.address.trim(),
        ...(input.memoType ? { memoType: input.memoType, memo: input.memo } : {}),
      },
    }),
    deleteUser: (_parent, { username }, context) => {
      requireUser(context, username);
      return prisma.user.update({
        where: { username },
        data: { deletedAt: new Date() },
      }).then(() => true);
    },
    createWebhook: (_parent, { username, url }, context) => {
      requireUser(context, username);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new GraphQLError('Webhook URL must be valid HTTP or HTTPS', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new GraphQLError('Webhook URL must be valid HTTP or HTTPS', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      return prisma.webhook.create({
        data: { username, url, secret: crypto.randomBytes(32).toString('hex') },
      });
    },
    deleteWebhook: (_parent, { id }, context) => {
      const owner = requireUser(context);
      return prisma.webhook.deleteMany({ where: { id, username: owner.username } })
        .then((result) => result.count > 0);
    },
  },
};

module.exports = { resolvers, requireUser };

'use strict';

/**
 * #685 — GraphQL layer.
 *
 * A read-only GraphQL API over the same services the REST routes use, so the
 * dashboard can ask for exactly the fields a screen needs in one round trip
 * instead of fanning out across several endpoints.
 *
 * Layout:
 *   typeDefs.js   — the SDL, i.e. the published contract
 *   schema.js     — compiles the SDL and attaches the resolvers
 *   loaders.js    — per-request DataLoaders (the N+1 guard)
 *   context.js    — per-request context and ownership checks
 *   resolvers/    — Query + type field resolvers
 *   playground.js — development-only GraphiQL page
 *   router.js     — Express mounting
 */

const { typeDefs } = require('./typeDefs');
const { makeSchema, attachResolvers, serializeDateTime, parseDateTimeInput, scalarResolvers } = require('./schema');
const { createLoaders, activityKey } = require('./loaders');
const {
  createContext,
  resolveViewer,
  requireUsernameOwner,
  requireWebhookOwnerUsername,
} = require('./context');
const resolvers = require('./resolvers');
const { playgroundHtml, playgroundPolicy } = require('./playground');
const {
  registerGraphQL,
  createSchema,
  formatError,
  isPlaygroundEnabled,
  GRAPHQL_PATH,
} = require('./router');

module.exports = {
  typeDefs,
  resolvers,
  createSchema,
  makeSchema,
  attachResolvers,
  serializeDateTime,
  parseDateTimeInput,
  scalarResolvers,
  createLoaders,
  activityKey,
  createContext,
  resolveViewer,
  requireUsernameOwner,
  requireWebhookOwnerUsername,
  playgroundHtml,
  playgroundPolicy,
  registerGraphQL,
  formatError,
  isPlaygroundEnabled,
  GRAPHQL_PATH,
};

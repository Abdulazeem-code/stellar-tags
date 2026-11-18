'use strict';

/**
 * Local development seed.
 *
 * Populates an empty database with 50 users, 10 webhooks, 20 payment intents
 * and 2 API keys so a new contributor can exercise the API without hand-
 * building fixtures.
 *
 * Re-running is safe. Every record is upserted on its natural key and all
 * identities (addresses, usernames, intent ids, API key hashes) are derived
 * from a fixed seed, so a second run updates the same rows instead of
 * inserting a new set. Webhook delivery timestamps are the deliberate
 * exception: they are relative to the current time so the healthy /
 * recently-failing / past-the-DLQ-cutoff states stay meaningful as the data
 * ages.
 *
 *   npm run db:seed              populate (or refresh) the seed data
 *   npm run db:seed -- --reset   delete the seed's own rows first
 */

const crypto = require('crypto');
const { StrKey } = require('@stellar/stellar-sdk');
const { v5: uuidv5 } = require('uuid');
require('dotenv').config();

const { logger } = require('../src/logger');
const { normalizeNameTag, RESERVED_NAMES } = require('../src/utils');

// Names are built from these rather than a generator library so the usernames,
// which are the users' primary key, cannot shift under a dependency upgrade and
// leave a second set of rows behind on the next run.
const FIRST_NAMES = [
  'ada', 'bello', 'chidi', 'dalia', 'emeka', 'farida', 'gwen', 'hassan',
  'imani', 'juno', 'kemi', 'lars', 'mira', 'nadia', 'olu', 'priya',
  'quinn', 'rosa', 'sami', 'tunde', 'uma', 'viktor', 'wren', 'zora',
];

const LAST_NAMES = [
  'abiola', 'bergman', 'castillo', 'diallo', 'eriksen', 'fontaine', 'garcia',
  'haddad', 'ibrahim', 'jensen', 'kowalski', 'lindqvist', 'mensah', 'novak',
  'okafor', 'pereira', 'quintero', 'rahman', 'silva', 'takahashi', 'ustinov',
  'varga', 'whitfield', 'zhang',
];

const USER_COUNT = 50;
const WEBHOOK_COUNT = 10;
const PAYMENT_INTENT_COUNT = 20;
const API_KEY_COUNT = 2;

// The first ALIAS_ADDRESS_COUNT addresses carry ALIASES_PER_ADDRESS usernames
// each so reverse (type=id) federation lookups and the isPrimary tiebreak have
// something to resolve against.
const ALIAS_ADDRESS_COUNT = 3;
const ALIASES_PER_ADDRESS = 3;

// webhookWorker moves a webhook to the DLQ once it has been failing for longer
// than this, so the seed straddles the boundary on purpose.
const MAX_RETRY_BACKLOG_DAYS = 3;

// The app itself only ever writes "pending" today; the rest exist so dashboard
// and status-filter work has data to read.
const PAYMENT_STATUSES = ['pending', 'processing', 'completed', 'failed'];

const API_KEY_PREFIX = 'sk_live_';
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Deterministic derivation
// ---------------------------------------------------------------------------

const digest = (label) =>
  crypto.createHash('sha256').update(`stellar-tags:seed:${label}`).digest();

const stellarAddress = (label) => StrKey.encodeEd25519PublicKey(digest(`address:${label}`));

const UUID_NAMESPACE = uuidv5('seed.stellar-tags.local', uuidv5.DNS);
const stableId = (label) => uuidv5(label, UUID_NAMESPACE);

// Anchored rather than relative to now so createdAt does not churn between runs.
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
const anchoredDate = (label, spanDays) =>
  new Date(EPOCH + (digest(`date:${label}`).readUInt32BE(0) % (spanDays * DAY_MS)));

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * A stable, readable local part per user index. The trailing number keeps the
 * combinations distinct well past USER_COUNT and keeps reserved names such as
 * "admin" or "support" out of the registry.
 */
const localName = (index) => {
  const h = digest(`username:${index}`);
  const first = FIRST_NAMES[h.readUInt16BE(0) % FIRST_NAMES.length];
  const last = LAST_NAMES[h.readUInt16BE(2) % LAST_NAMES.length];
  const suffix = h.readUInt16BE(4) % 10000;
  const local = `${first}.${last}${suffix}`;
  return RESERVED_NAMES.includes(local) ? `${local}x` : local;
};

const memoFor = (index) => {
  switch (index % 4) {
    case 1:
      return { memoType: 'text', memo: `invoice-${String(index).padStart(4, '0')}` };
    case 2:
      return { memoType: 'id', memo: String(100000 + index) };
    case 3:
      return { memoType: 'hash', memo: digest(`memo:${index}`).toString('hex') };
    default:
      return { memoType: null, memo: null };
  }
};

/**
 * Builds the user rows. Addresses come straight off the hash chain, so
 * `--reset` can always find the rows this script owns.
 */
const buildUsers = () => {
  const users = [];
  let addressSlot = 0;

  while (users.length < USER_COUNT) {
    const address = stellarAddress(addressSlot);
    const aliasCount =
      addressSlot < ALIAS_ADDRESS_COUNT
        ? Math.min(ALIASES_PER_ADDRESS, USER_COUNT - users.length)
        : 1;

    for (let alias = 0; alias < aliasCount; alias++) {
      const index = users.length;
      const username = normalizeNameTag(localName(index)).toLowerCase();

      users.push({
        username,
        address,
        // The first username registered for an address is its primary.
        isPrimary: alias === 0,
        ...memoFor(index),
        createdAt: anchoredDate(`user:${index}`, 365),
        // Every 17th user is flagged and every 23rd soft-deleted, so the
        // moderation and purge paths have rows without swamping the list
        // endpoints with hidden records.
        flaggedAt: index % 17 === 16 ? anchoredDate(`flag:${index}`, 30) : null,
        deletedAt: index % 23 === 22 ? anchoredDate(`delete:${index}`, 30) : null,
      });
    }

    addressSlot++;
  }

  return users;
};

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Spreads the webhooks across four delivery states: never attempted, healthy,
 * failing but still inside the retry window, and failing past the cutoff where
 * webhookWorker moves the record to the DLQ.
 */
const webhookState = (index, now) => {
  if (index < 2) {
    return { lastSentAt: null, failingSince: null };
  }
  if (index < 7) {
    return { lastSentAt: new Date(now - (index + 1) * 3600 * 1000), failingSince: null };
  }
  if (index < 9) {
    return {
      lastSentAt: new Date(now - 2 * 3600 * 1000),
      failingSince: new Date(now - (MAX_RETRY_BACKLOG_DAYS - 2) * DAY_MS),
    };
  }
  return {
    lastSentAt: new Date(now - 6 * 3600 * 1000),
    failingSince: new Date(now - (MAX_RETRY_BACKLOG_DAYS + 2) * DAY_MS),
  };
};

const buildWebhooks = (users, now = Date.now()) => {
  const owners = users.filter((u) => u.isPrimary && !u.deletedAt).slice(0, WEBHOOK_COUNT);

  return owners.map((owner, index) => ({
    id: stableId(`webhook:${index}`),
    username: owner.username,
    url: `https://webhook-${index}.merchant.localhost/stellar-tags`,
    // Same shape as the 32 random bytes the register endpoint issues.
    secret: digest(`webhook-secret:${index}`).toString('hex'),
    events: index % 3 === 0 ? ['payment.received'] : ['*'],
    createdAt: anchoredDate(`webhook:${index}`, 180),
    ...webhookState(index, now),
  }));
};

// ---------------------------------------------------------------------------
// Payment intents
// ---------------------------------------------------------------------------

// Seven decimal places, matching Stellar's asset precision.
const amountFor = (index) => {
  const raw = digest(`amount:${index}`).readUInt32BE(0) % 50_000_000;
  return ((raw + 1) / 10_000).toFixed(7);
};

const buildPaymentIntents = (users) => {
  const addresses = [...new Set(users.map((u) => u.address))];

  return Array.from({ length: PAYMENT_INTENT_COUNT }, (_, index) => {
    const status = PAYMENT_STATUSES[index % PAYMENT_STATUSES.length];

    return {
      id: stableId(`payment-intent:${index}`),
      externalId: `seed-intent-${String(index).padStart(3, '0')}`,
      from: addresses[index % addresses.length],
      to: addresses[(index + 7) % addresses.length],
      amount: amountFor(index),
      asset: index % 3 === 0 ? 'XLM' : 'USDC',
      ...memoFor(index),
      metadata: {
        invoice: `INV-${String(index).padStart(5, '0')}`,
        customer: `${localName(index)} ltd`,
        source: 'seed',
      },
      status,
      createdAt: anchoredDate(`payment-intent:${index}`, 90),
    };
  });
};

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/**
 * Derives the two keys from the fixed seed so the raw values can be printed
 * for local use and re-derived on every run. Only the hash is stored, matching
 * what POST /auth/api-keys does.
 */
const buildApiKeys = () => {
  const specs = [
    { label: 'primary', name: 'Local development key', scopes: ['read', 'write'], revoked: false },
    { label: 'revoked', name: 'Revoked key (auth failure path)', scopes: ['read'], revoked: true },
  ].slice(0, API_KEY_COUNT);

  return specs.map((spec, index) => {
    const rawKey = API_KEY_PREFIX + digest(`api-key:${spec.label}`).toString('hex');

    return {
      rawKey,
      record: {
        id: stableId(`api-key:${spec.label}`),
        name: spec.name,
        ownerId: `seed-owner-${index}`,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.slice(0, 12),
        scopes: spec.scopes,
        expiresAt: null,
        revokedAt: spec.revoked ? anchoredDate(`api-key-revoked:${spec.label}`, 30) : null,
        revokedBy: spec.revoked ? 'seed' : null,
        createdAt: anchoredDate(`api-key:${spec.label}`, 200),
      },
    };
  });
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const isLocalDatabase = (url) => {
  try {
    const { hostname } = new URL(url);
    return ['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(hostname);
  } catch {
    return false;
  }
};

const assertSeedable = (env = process.env) => {
  if (!env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. The seed needs a real database, see .env.example.',
    );
  }
  if (!isLocalDatabase(env.DATABASE_URL) && env.SEED_ALLOW_REMOTE !== '1') {
    throw new Error(
      'DATABASE_URL does not point at a local database. Set SEED_ALLOW_REMOTE=1 to override.',
    );
  }
};

const resetSeedData = async (prisma, { users, webhooks, paymentIntents, apiKeys }) => {
  // Webhooks cascade from their user, but the seed deletes them explicitly so a
  // reset stays correct if an owner has since been removed by hand.
  await prisma.webhook.deleteMany({ where: { id: { in: webhooks.map((w) => w.id) } } });
  await prisma.paymentIntent.deleteMany({
    where: { id: { in: paymentIntents.map((p) => p.id) } },
  });
  await prisma.apiKey.deleteMany({ where: { id: { in: apiKeys.map((k) => k.record.id) } } });
  await prisma.user.deleteMany({
    where: { address: { in: [...new Set(users.map((u) => u.address))] } },
  });
};

const writeSeedData = async (prisma, { users, webhooks, paymentIntents, apiKeys }) => {
  for (const user of users) {
    const { username, ...rest } = user;
    await prisma.user.upsert({
      where: { username },
      create: { username, ...rest },
      update: rest,
    });
  }

  for (const webhook of webhooks) {
    const { username, url, ...rest } = webhook;
    await prisma.webhook.upsert({
      where: { username_url: { username, url } },
      create: { username, url, ...rest },
      update: rest,
    });
  }

  for (const intent of paymentIntents) {
    const { id, ...rest } = intent;
    await prisma.paymentIntent.upsert({ where: { id }, create: { id, ...rest }, update: rest });
  }

  for (const { record } of apiKeys) {
    const { keyHash, ...rest } = record;
    await prisma.apiKey.upsert({
      where: { keyHash },
      create: { keyHash, ...rest },
      update: rest,
    });
  }
};

const seedDatabase = async ({ reset = false } = {}) => {
  assertSeedable();

  // Required after assertSeedable: importing earlier would bind the fallback
  // mock in prismaClient when DATABASE_URL is missing, and the seed would
  // report success while writing nothing.
  const { prisma } = require('../prismaClient');

  const users = buildUsers();
  const data = {
    users,
    webhooks: buildWebhooks(users),
    paymentIntents: buildPaymentIntents(users),
    apiKeys: buildApiKeys(),
  };

  try {
    if (reset) {
      logger.info('Deleting existing seed records...');
      await resetSeedData(prisma, data);
    }

    await writeSeedData(prisma, data);

    logger.info(
      `Seeded ${data.users.length} users, ${data.webhooks.length} webhooks, ` +
        `${data.paymentIntents.length} payment intents, ${data.apiKeys.length} API keys.`,
    );
    for (const { rawKey, record } of data.apiKeys) {
      const state = record.revokedAt ? 'revoked' : 'active';
      logger.info(`API key (${state}) ${record.name}: ${rawKey}`);
    }
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  seedDatabase({ reset: process.argv.includes('--reset') }).catch((error) => {
    logger.error(error, 'Seeding failed');
    process.exitCode = 1;
  });
}

module.exports = {
  buildUsers,
  buildWebhooks,
  buildPaymentIntents,
  buildApiKeys,
  resetSeedData,
  writeSeedData,
  assertSeedable,
  isLocalDatabase,
  seedDatabase,
  USER_COUNT,
  WEBHOOK_COUNT,
  PAYMENT_INTENT_COUNT,
  API_KEY_COUNT,
  PAYMENT_STATUSES,
  MAX_RETRY_BACKLOG_DAYS,
};

'use strict';

jest.mock('../src/logger', () => ({ logger: require('pino')({ level: 'silent' }) }));

// The SDK is ESM-only under this jest config, so StrKey is stubbed here the way
// the rest of the suite stubs it. That keeps the encoder itself out of scope;
// what the seed owns is the 32-byte payload it hands over, asserted below.
jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    encodeEd25519PublicKey: jest.fn((payload) => `G${payload.toString('hex').toUpperCase()}`),
    isValidEd25519PublicKey: (value) => /^G[0-9A-F]{64}$/.test(value),
  },
}));

const { StrKey } = require('@stellar/stellar-sdk');
const { validateMemo, RESERVED_NAMES } = require('../src/utils');
const seed = require('../scripts/seed');

const {
  buildUsers,
  buildWebhooks,
  buildPaymentIntents,
  buildApiKeys,
  writeSeedData,
  resetSeedData,
  assertSeedable,
  isLocalDatabase,
  USER_COUNT,
  WEBHOOK_COUNT,
  PAYMENT_INTENT_COUNT,
  API_KEY_COUNT,
  PAYMENT_STATUSES,
  MAX_RETRY_BACKLOG_DAYS,
} = seed;

const DAY_MS = 24 * 60 * 60 * 1000;

const mockPrisma = () => {
  const model = () => ({
    upsert: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  });
  return {
    user: model(),
    webhook: model(),
    paymentIntent: model(),
    apiKey: model(),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
};

describe('seed data generation', () => {
  const users = buildUsers();
  const webhooks = buildWebhooks(users);
  const intents = buildPaymentIntents(users);
  const apiKeys = buildApiKeys();

  test('produces the record counts the issue asks for', () => {
    expect(users).toHaveLength(USER_COUNT);
    expect(webhooks).toHaveLength(WEBHOOK_COUNT);
    expect(intents).toHaveLength(PAYMENT_INTENT_COUNT);
    expect(apiKeys).toHaveLength(API_KEY_COUNT);
  });

  test('is deterministic across separate invocations', () => {
    expect(buildUsers()).toEqual(users);
    expect(buildPaymentIntents(buildUsers())).toEqual(intents);
    expect(buildApiKeys()).toEqual(apiKeys);
    // Webhook delivery timestamps track the current time, so pin it.
    const now = Date.UTC(2026, 4, 1);
    expect(buildWebhooks(buildUsers(), now)).toEqual(buildWebhooks(users, now));
  });
});

describe('users', () => {
  const users = buildUsers();

  test('every username is unique and federation-normalised', () => {
    const names = users.map((u) => u.username);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9.\-_]+\*localhost$/);
      expect(RESERVED_NAMES).not.toContain(name.split('*')[0]);
    }
  });

  test('hands StrKey a distinct 32-byte payload per address', () => {
    const payloads = StrKey.encodeEd25519PublicKey.mock.calls.map(([buf]) => buf);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(Buffer.isBuffer(payload)).toBe(true);
      expect(payload).toHaveLength(32);
    }

    const addresses = [...new Set(users.map((u) => u.address))];
    expect(addresses).toHaveLength(44);
    for (const address of addresses) {
      expect(StrKey.isValidEd25519PublicKey(address)).toBe(true);
    }
  });

  test('covers every memo type and every memo passes validateMemo', () => {
    const types = new Set(users.map((u) => u.memoType));
    expect(types).toEqual(new Set([null, 'text', 'id', 'hash']));

    for (const user of users) {
      expect(validateMemo(user.memoType, user.memo)).toBeNull();
    }
  });

  test('each address has exactly one primary username', () => {
    const byAddress = new Map();
    for (const user of users) {
      byAddress.set(user.address, [...(byAddress.get(user.address) || []), user]);
    }
    for (const group of byAddress.values()) {
      expect(group.filter((u) => u.isPrimary)).toHaveLength(1);
      expect(group[0].isPrimary).toBe(true);
    }
  });

  test('seeds address aliases so reverse federation lookups have data', () => {
    const counts = new Map();
    for (const user of users) {
      counts.set(user.address, (counts.get(user.address) || 0) + 1);
    }
    expect([...counts.values()].filter((n) => n > 1).length).toBeGreaterThan(0);
    expect(users.length).toBeGreaterThan(counts.size);
  });

  test('includes flagged and soft-deleted users', () => {
    expect(users.some((u) => u.flaggedAt)).toBe(true);
    expect(users.some((u) => u.deletedAt)).toBe(true);
    expect(users.filter((u) => u.deletedAt).length).toBeLessThan(users.length / 2);
  });
});

describe('webhooks', () => {
  const now = Date.UTC(2026, 4, 1);
  const users = buildUsers();
  const webhooks = buildWebhooks(users, now);

  test('covers healthy and failing delivery states', () => {
    const healthy = webhooks.filter((w) => w.lastSentAt && !w.failingSince);
    const neverSent = webhooks.filter((w) => !w.lastSentAt && !w.failingSince);
    const failing = webhooks.filter((w) => w.failingSince);

    expect(healthy.length).toBeGreaterThan(0);
    expect(neverSent.length).toBeGreaterThan(0);
    expect(failing.length).toBeGreaterThan(0);
  });

  test('straddles the DLQ cutoff so both retry paths have rows', () => {
    const failing = webhooks.filter((w) => w.failingSince);
    const ageDays = (w) => (now - w.failingSince.getTime()) / DAY_MS;

    expect(failing.some((w) => ageDays(w) < MAX_RETRY_BACKLOG_DAYS)).toBe(true);
    expect(failing.some((w) => ageDays(w) > MAX_RETRY_BACKLOG_DAYS)).toBe(true);
  });

  test('belongs to primary, non-deleted users and is uniquely addressed', () => {
    const owners = new Map(users.map((u) => [u.username, u]));
    for (const webhook of webhooks) {
      const owner = owners.get(webhook.username);
      expect(owner).toBeDefined();
      expect(owner.isPrimary).toBe(true);
      expect(owner.deletedAt).toBeNull();
    }

    const keys = webhooks.map((w) => `${w.username}|${w.url}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('issues a 32-byte hex secret and a usable event filter', () => {
    for (const webhook of webhooks) {
      expect(webhook.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(webhook.events.length).toBeGreaterThan(0);
    }
    expect(webhooks.some((w) => w.events.includes('*'))).toBe(true);
    expect(webhooks.some((w) => w.events.includes('payment.received'))).toBe(true);
  });
});

describe('payment intents', () => {
  const users = buildUsers();
  const intents = buildPaymentIntents(users);

  test('covers every status', () => {
    expect(new Set(intents.map((i) => i.status))).toEqual(new Set(PAYMENT_STATUSES));
  });

  test('references seeded addresses and carries a numeric amount', () => {
    const addresses = new Set(users.map((u) => u.address));
    for (const intent of intents) {
      expect(addresses.has(intent.from)).toBe(true);
      expect(addresses.has(intent.to)).toBe(true);
      expect(Number(intent.amount)).toBeGreaterThan(0);
      expect(validateMemo(intent.memoType, intent.memo)).toBeNull();
    }
  });

  test('gives every intent a distinct id and external id', () => {
    expect(new Set(intents.map((i) => i.id)).size).toBe(intents.length);
    expect(new Set(intents.map((i) => i.externalId)).size).toBe(intents.length);
  });
});

describe('api keys', () => {
  const apiKeys = buildApiKeys();

  test('stores only a hash that matches the printed raw key', () => {
    const crypto = require('crypto');
    for (const { rawKey, record } of apiKeys) {
      expect(rawKey.startsWith('sk_live_')).toBe(true);
      expect(record.keyHash).toBe(crypto.createHash('sha256').update(rawKey).digest('hex'));
      expect(record.keyPrefix).toBe(rawKey.slice(0, 12));
      expect(record).not.toHaveProperty('rawKey');
    }
  });

  test('seeds an active key and a revoked one', () => {
    expect(apiKeys.filter((k) => !k.record.revokedAt)).toHaveLength(1);
    expect(apiKeys.filter((k) => k.record.revokedAt)).toHaveLength(1);
  });
});

describe('writeSeedData', () => {
  const users = buildUsers();
  const data = {
    users,
    webhooks: buildWebhooks(users, Date.UTC(2026, 4, 1)),
    paymentIntents: buildPaymentIntents(users),
    apiKeys: buildApiKeys(),
  };

  test('upserts every record on its natural key', async () => {
    const prisma = mockPrisma();
    await writeSeedData(prisma, data);

    expect(prisma.user.upsert).toHaveBeenCalledTimes(USER_COUNT);
    expect(prisma.webhook.upsert).toHaveBeenCalledTimes(WEBHOOK_COUNT);
    expect(prisma.paymentIntent.upsert).toHaveBeenCalledTimes(PAYMENT_INTENT_COUNT);
    expect(prisma.apiKey.upsert).toHaveBeenCalledTimes(API_KEY_COUNT);

    expect(prisma.user.upsert.mock.calls[0][0].where).toEqual({
      username: data.users[0].username,
    });
    expect(prisma.webhook.upsert.mock.calls[0][0].where).toEqual({
      username_url: { username: data.webhooks[0].username, url: data.webhooks[0].url },
    });
    expect(prisma.paymentIntent.upsert.mock.calls[0][0].where).toEqual({
      id: data.paymentIntents[0].id,
    });
    expect(prisma.apiKey.upsert.mock.calls[0][0].where).toEqual({
      keyHash: data.apiKeys[0].record.keyHash,
    });
  });

  test('never inserts a raw API key', async () => {
    const prisma = mockPrisma();
    await writeSeedData(prisma, data);

    const written = JSON.stringify(prisma.apiKey.upsert.mock.calls);
    for (const { rawKey } of data.apiKeys) {
      expect(written).not.toContain(rawKey);
    }
  });

  test('a second run repeats the same writes, so no duplicates appear', async () => {
    const first = mockPrisma();
    const second = mockPrisma();

    await writeSeedData(first, data);
    await writeSeedData(second, data);

    for (const model of ['user', 'webhook', 'paymentIntent', 'apiKey']) {
      expect(second[model].upsert.mock.calls).toEqual(first[model].upsert.mock.calls);
    }
  });

  test('reset deletes only the rows the seed owns', async () => {
    const prisma = mockPrisma();
    await resetSeedData(prisma, data);

    expect(prisma.webhook.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: data.webhooks.map((w) => w.id) } },
    });
    expect(prisma.user.deleteMany).toHaveBeenCalledWith({
      where: { address: { in: [...new Set(data.users.map((u) => u.address))] } },
    });
    expect(prisma.paymentIntent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: data.paymentIntents.map((p) => p.id) } },
    });
  });
});

describe('assertSeedable', () => {
  test('rejects a missing DATABASE_URL', () => {
    expect(() => assertSeedable({})).toThrow(/DATABASE_URL is not set/);
  });

  test('rejects a non-local database unless explicitly allowed', () => {
    const remote = { DATABASE_URL: 'postgresql://u:p@db.example.com:5432/prod' };
    expect(() => assertSeedable(remote)).toThrow(/SEED_ALLOW_REMOTE/);
    expect(() => assertSeedable({ ...remote, SEED_ALLOW_REMOTE: '1' })).not.toThrow();
  });

  test('accepts the local URLs from .env.example and docker-compose', () => {
    expect(isLocalDatabase('postgresql://postgres:postgres@localhost:5432/stellar_tags')).toBe(true);
    expect(isLocalDatabase('postgresql://postgres:postgres@postgres:5432/stellar_tags')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@db.example.com:5432/prod')).toBe(false);
    expect(isLocalDatabase('not a url')).toBe(false);
  });
});

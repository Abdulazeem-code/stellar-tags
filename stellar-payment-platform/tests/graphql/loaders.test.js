'use strict';

/**
 * #685 — DataLoader batching.
 *
 * This is the test that holds up the "no N+1" claim. Each case resolves the
 * same relation across many parents in one tick and asserts the number of
 * database calls, so a future resolver that reaches for Prisma directly instead
 * of going through a loader shows up as a failing count rather than as a slow
 * dashboard nobody notices.
 */

const { createLoaders, activityKey, clampActivityLimit } = require('../../src/graphql/loaders');
const { createFakePrisma } = require('./support/fakePrisma');

const user = (name, address, extra = {}) => ({
  username: name,
  address,
  isPrimary: true,
  memoType: null,
  memo: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  flaggedAt: null,
  deletedAt: null,
  ...extra,
});

const webhook = (id, username, extra = {}) => ({
  id,
  username,
  url: `https://example.test/${id}`,
  secret: 'super-secret-value',
  events: ['payment.completed'],
  createdAt: new Date('2026-01-02T00:00:00.000Z'),
  lastSentAt: null,
  failingSince: null,
  ...extra,
});

describe('userByUsername', () => {
  it('batches many keys into one query and preserves key order', async () => {
    const prisma = createFakePrisma({
      users: [user('alice*localhost', 'G_ALICE'), user('bob*localhost', 'G_BOB')],
    });
    const loaders = createLoaders(prisma);

    const results = await Promise.all([
      loaders.userByUsername.load('alice*localhost'),
      loaders.userByUsername.load('bob*localhost'),
      loaders.userByUsername.load('carol*localhost'),
    ]);

    expect(prisma.__callsTo('user', 'findMany')).toHaveLength(1);
    expect(prisma.__callsTo('user', 'findMany')[0].args.where).toEqual({
      username: { in: ['alice*localhost', 'bob*localhost', 'carol*localhost'] },
    });
    expect(results[0].username).toBe('alice*localhost');
    expect(results[1].username).toBe('bob*localhost');
    expect(results[2]).toBeNull();
  });

  it('collapses a repeated key into a single lookup', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', 'G_ALICE')] });
    const loaders = createLoaders(prisma);

    const [first, second] = await Promise.all([
      loaders.userByUsername.load('alice*localhost'),
      loaders.userByUsername.load('alice*localhost'),
    ]);

    expect(prisma.__callsTo('user', 'findMany')).toHaveLength(1);
    expect(first).toBe(second);
  });

  it('serves a repeat of the same key from cache without a query', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', 'G_ALICE')] });
    const loaders = createLoaders(prisma);

    await loaders.userByUsername.load('alice*localhost');
    prisma.__reset();
    const again = await loaders.userByUsername.load('alice*localhost');

    expect(prisma.__callsTo('user', 'findMany')).toHaveLength(0);
    expect(again.username).toBe('alice*localhost');
  });
});

describe('userByAddress', () => {
  it('batches and returns the primary username per address', async () => {
    const prisma = createFakePrisma({
      users: [
        user('billing*localhost', 'G_SHARED', { isPrimary: false, createdAt: new Date('2026-02-01T00:00:00.000Z') }),
        user('payments*localhost', 'G_SHARED', { isPrimary: true, createdAt: new Date('2026-01-01T00:00:00.000Z') }),
        user('alice*localhost', 'G_ALICE'),
      ],
    });
    const loaders = createLoaders(prisma);

    const [shared, other] = await Promise.all([
      loaders.userByAddress.load('G_SHARED'),
      loaders.userByAddress.load('G_ALICE'),
    ]);

    expect(prisma.__callsTo('user', 'findMany')).toHaveLength(1);
    expect(shared.username).toBe('payments*localhost');
    expect(other.username).toBe('alice*localhost');
  });

  it('hides soft-deleted rows', async () => {
    const prisma = createFakePrisma({
      users: [user('alice*localhost', 'G_ALICE', { deletedAt: new Date('2026-05-01T00:00:00.000Z') })],
    });
    const loaders = createLoaders(prisma);

    expect(await loaders.userByAddress.load('G_ALICE')).toBeNull();
  });
});

describe('webhooksByUsername', () => {
  it('resolves a list of parents in one query', async () => {
    const prisma = createFakePrisma({
      webhooks: [
        webhook('w1', 'alice*localhost'),
        webhook('w2', 'bob*localhost'),
        webhook('w3', 'alice*localhost'),
      ],
    });
    const loaders = createLoaders(prisma);

    const [alice, bob, nobody] = await Promise.all([
      loaders.webhooksByUsername.load('alice*localhost'),
      loaders.webhooksByUsername.load('bob*localhost'),
      loaders.webhooksByUsername.load('carol*localhost'),
    ]);

    expect(prisma.__callsTo('webhook', 'findMany')).toHaveLength(1);
    expect(alice.map((w) => w.id).sort()).toEqual(['w1', 'w3']);
    expect(bob.map((w) => w.id)).toEqual(['w2']);
    expect(nobody).toEqual([]);
  });
});

describe('webhookCountByUsername', () => {
  it('counts the whole batch with a single GROUP BY', async () => {
    const prisma = createFakePrisma({
      webhooks: [
        webhook('w1', 'alice*localhost'),
        webhook('w2', 'alice*localhost'),
        webhook('w3', 'bob*localhost'),
      ],
    });
    const loaders = createLoaders(prisma);

    const [alice, bob, nobody] = await Promise.all([
      loaders.webhookCountByUsername.load('alice*localhost'),
      loaders.webhookCountByUsername.load('bob*localhost'),
      loaders.webhookCountByUsername.load('carol*localhost'),
    ]);

    expect(prisma.__callsTo('webhook', 'groupBy')).toHaveLength(1);
    expect([alice, bob, nobody]).toEqual([2, 1, 0]);
  });
});

describe('activity loaders', () => {
  const activity = (id, username, day) => ({
    id,
    username,
    action: 'user.registered',
    metadata: null,
    ipAddress: null,
    createdAt: new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`),
  });

  it('returns at most `limit` rows per parent, newest first', async () => {
    const prisma = createFakePrisma({
      activityLogs: [
        activity('a1', 'alice*localhost', 1),
        activity('a2', 'alice*localhost', 2),
        activity('a3', 'alice*localhost', 3),
        activity('b1', 'bob*localhost', 1),
      ],
    });
    const loaders = createLoaders(prisma);

    const [alice, bob] = await Promise.all([
      loaders.activityByUsername.load(activityKey('alice*localhost', 2)),
      loaders.activityByUsername.load(activityKey('bob*localhost', 5)),
    ]);

    expect(prisma.__callsTo('activityLog', 'findMany')).toHaveLength(1);
    expect(alice.map((row) => row.id)).toEqual(['a3', 'a2']);
    expect(bob.map((row) => row.id)).toEqual(['b1']);
  });

  it('keeps different page sizes for the same username apart', async () => {
    const prisma = createFakePrisma({
      activityLogs: [
        activity('a1', 'alice*localhost', 1),
        activity('a2', 'alice*localhost', 2),
      ],
    });
    const loaders = createLoaders(prisma);

    const [one, both] = await Promise.all([
      loaders.activityByUsername.load(activityKey('alice*localhost', 1)),
      loaders.activityByUsername.load(activityKey('alice*localhost', 2)),
    ]);

    expect(one.map((row) => row.id)).toEqual(['a2']);
    expect(both.map((row) => row.id)).toEqual(['a2', 'a1']);
  });

  it('clamps the page size to the service bounds', () => {
    expect(clampActivityLimit(undefined)).toBe(20);
    expect(clampActivityLimit(0)).toBe(20);
    expect(clampActivityLimit(5)).toBe(5);
    expect(clampActivityLimit(9999)).toBe(100);
  });

  it('counts every username in one GROUP BY', async () => {
    const prisma = createFakePrisma({
      activityLogs: [
        activity('a1', 'alice*localhost', 1),
        activity('a2', 'alice*localhost', 2),
        activity('b1', 'bob*localhost', 1),
      ],
    });
    const loaders = createLoaders(prisma);

    const counts = await Promise.all([
      loaders.activityCountByUsername.load('alice*localhost'),
      loaders.activityCountByUsername.load('bob*localhost'),
      loaders.activityCountByUsername.load('carol*localhost'),
    ]);

    expect(prisma.__callsTo('activityLog', 'groupBy')).toHaveLength(1);
    expect(counts).toEqual([2, 1, 0]);
  });
});

describe('payment aggregate loaders', () => {
  const payment = (id, from, to, amount, fee) => ({
    id,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    fromAddress: from,
    toAddress: to,
    amount,
    fee,
    assetCode: 'XLM',
    transactionHash: null,
    status: 'completed',
  });

  it('groups sent totals with one query for the whole batch', async () => {
    const prisma = createFakePrisma({
      payments: [
        payment('p1', 'G_ALICE', 'G_BOB', 10, 0.00001),
        payment('p2', 'G_ALICE', 'G_BOB', 5, 0.00002),
        payment('p3', 'G_BOB', 'G_ALICE', 1, 0.00003),
      ],
    });
    const loaders = createLoaders(prisma);

    const [alice, bob, nobody] = await Promise.all([
      loaders.sentStatsByAddress.load('G_ALICE'),
      loaders.sentStatsByAddress.load('G_BOB'),
      loaders.sentStatsByAddress.load('G_NOBODY'),
    ]);

    expect(prisma.__callsTo('payment', 'groupBy')).toHaveLength(1);
    expect(alice).toEqual({ count: 2, amount: 15, fees: expect.any(Number) });
    expect(bob.count).toBe(1);
    expect(nobody).toEqual({ count: 0, amount: 0, fees: 0 });
  });

  it('groups received totals separately from sent', async () => {
    const prisma = createFakePrisma({
      payments: [payment('p1', 'G_ALICE', 'G_BOB', 10, 0.00001)],
    });
    const loaders = createLoaders(prisma);

    const [sent, received] = await Promise.all([
      loaders.sentStatsByAddress.load('G_ALICE'),
      loaders.receivedStatsByAddress.load('G_BOB'),
    ]);

    expect(prisma.__callsTo('payment', 'groupBy')).toHaveLength(2);
    expect(sent.count).toBe(1);
    expect(received.count).toBe(1);
  });
});

describe('loader lifecycle', () => {
  it('does not share cached rows between two request-scoped loaders', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', 'G_ALICE')] });

    const first = createLoaders(prisma);
    expect(await first.userByUsername.load('alice*localhost')).not.toBeNull();

    // A second request gets fresh loaders, so it must query again — this is the
    // property that stops one caller reading another's cached rows.
    const second = createLoaders(prisma);
    expect(await second.userByUsername.load('alice*localhost')).not.toBeNull();

    expect(prisma.__callsTo('user', 'findMany')).toHaveLength(2);
  });
});

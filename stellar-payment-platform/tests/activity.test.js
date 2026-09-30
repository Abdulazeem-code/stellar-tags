'use strict';

jest.mock('../src/logger', () => ({ logger: require('pino')({ level: 'silent' }) }));

const {
  ACTIVITY_ACTIONS,
  recordActivity,
  listActivity,
  parseDateRange,
  serializeActivity,
  clientIp,
  MAX_METADATA_BYTES,
  MAX_PAGE_SIZE,
} = require('../src/services/activityService');

const mockPrisma = () => ({
  activityLog: {
    create: jest.fn().mockResolvedValue({ id: 'row-1' }),
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  },
});

describe('recordActivity', () => {
  test('writes the row the caller described', async () => {
    const prisma = mockPrisma();
    await recordActivity(prisma, {
      username: 'ada*localhost',
      action: ACTIVITY_ACTIONS.USER_REGISTERED,
      metadata: { address: 'GABC' },
      req: { ip: '10.0.0.9', headers: {} },
    });

    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: {
        username: 'ada*localhost',
        action: 'user.registered',
        metadata: { address: 'GABC' },
        ipAddress: '10.0.0.9',
      },
    });
  });

  test('swallows a write failure so the request still succeeds', async () => {
    const prisma = mockPrisma();
    prisma.activityLog.create.mockRejectedValue(new Error('database is down'));

    await expect(
      recordActivity(prisma, { username: 'ada*localhost', action: 'user.registered' }),
    ).resolves.toBeNull();
  });

  test('ignores a call with no username or action', async () => {
    const prisma = mockPrisma();
    await recordActivity(prisma, { username: '', action: 'user.registered' });
    await recordActivity(prisma, { username: 'ada*localhost', action: '' });

    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });

  test('replaces metadata that would bloat the row', async () => {
    const prisma = mockPrisma();
    await recordActivity(prisma, {
      username: 'ada*localhost',
      action: 'user.registered',
      metadata: { blob: 'x'.repeat(MAX_METADATA_BYTES + 1) },
    });

    expect(prisma.activityLog.create.mock.calls[0][0].data.metadata).toEqual({ truncated: true });
  });

  test('keeps metadata that fits', async () => {
    const prisma = mockPrisma();
    const metadata = { url: 'https://example.test/hook', events: ['*'] };
    await recordActivity(prisma, { username: 'ada*localhost', action: 'webhook.created', metadata });

    expect(prisma.activityLog.create.mock.calls[0][0].data.metadata).toEqual(metadata);
  });

  test('records no IP when there is no request', async () => {
    const prisma = mockPrisma();
    await recordActivity(prisma, { username: 'ada*localhost', action: 'user.blocked' });

    expect(prisma.activityLog.create.mock.calls[0][0].data.ipAddress).toBeNull();
  });
});

describe('clientIp', () => {
  test('prefers the first x-forwarded-for entry', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, ip: '10.0.0.1' }))
      .toBe('203.0.113.7');
  });

  test('falls back to the socket address', () => {
    expect(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.4' } })).toBe('10.0.0.4');
  });

  test('returns null when nothing identifies the caller', () => {
    expect(clientIp({ headers: {} })).toBeNull();
  });
});

describe('parseDateRange', () => {
  test('returns no range when neither bound is given', () => {
    expect(parseDateRange({})).toEqual({ range: null, error: null });
  });

  test('builds gte and lte bounds', () => {
    const { range, error } = parseDateRange({ startDate: '2026-01-01', endDate: '2026-02-01' });
    expect(error).toBeNull();
    expect(range.gte).toEqual(new Date('2026-01-01'));
    expect(range.lte).toEqual(new Date('2026-02-01'));
  });

  test('accepts a single bound', () => {
    expect(parseDateRange({ startDate: '2026-01-01' }).range).toEqual({
      gte: new Date('2026-01-01'),
    });
    expect(parseDateRange({ endDate: '2026-01-01' }).range).toEqual({
      lte: new Date('2026-01-01'),
    });
  });

  test('reports which bound is unparseable', () => {
    expect(parseDateRange({ startDate: 'yesterday' }).error).toBe('Invalid startDate');
    expect(parseDateRange({ endDate: 'soon' }).error).toBe('Invalid endDate');
  });

  test('rejects an inverted range', () => {
    const { range, error } = parseDateRange({ startDate: '2026-06-01', endDate: '2026-01-01' });
    expect(range).toBeNull();
    expect(error).toMatch(/must not be after/);
  });
});

describe('listActivity', () => {
  test('scopes the query to one user, newest first', async () => {
    const prisma = mockPrisma();
    await listActivity(prisma, { username: 'ada*localhost', page: 1, limit: 20 });

    const query = prisma.activityLog.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ username: 'ada*localhost' });
    expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(query).toMatchObject({ skip: 0, take: 20 });
    expect(prisma.activityLog.count).toHaveBeenCalledWith({ where: { username: 'ada*localhost' } });
  });

  test('applies the date range to both the page and the count', async () => {
    const prisma = mockPrisma();
    const range = { gte: new Date('2026-01-01') };
    await listActivity(prisma, { username: 'ada*localhost', range });

    const expected = { username: 'ada*localhost', createdAt: range };
    expect(prisma.activityLog.findMany.mock.calls[0][0].where).toEqual(expected);
    expect(prisma.activityLog.count.mock.calls[0][0].where).toEqual(expected);
  });

  test('translates page and limit into skip and take', async () => {
    const prisma = mockPrisma();
    await listActivity(prisma, { username: 'ada*localhost', page: 3, limit: 15 });

    expect(prisma.activityLog.findMany.mock.calls[0][0]).toMatchObject({ skip: 30, take: 15 });
  });

  test('caps the page size and floors the page number', async () => {
    const prisma = mockPrisma();
    await listActivity(prisma, { username: 'ada*localhost', page: 0, limit: 5000 });

    expect(prisma.activityLog.findMany.mock.calls[0][0]).toMatchObject({
      skip: 0,
      take: MAX_PAGE_SIZE,
    });
  });

  test('returns the rows alongside the unpaged total', async () => {
    const prisma = mockPrisma();
    prisma.activityLog.count.mockResolvedValue(42);
    prisma.activityLog.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    await expect(listActivity(prisma, { username: 'ada*localhost' })).resolves.toEqual({
      rows: [{ id: 'a' }, { id: 'b' }],
      total: 42,
    });
  });
});

describe('serializeActivity', () => {
  test('exposes snake_case fields and an ISO timestamp', () => {
    const createdAt = new Date('2026-03-04T05:06:07.000Z');
    expect(
      serializeActivity({
        id: 'row-1',
        action: 'webhook.created',
        metadata: { url: 'https://example.test' },
        ipAddress: '10.0.0.9',
        createdAt,
      }),
    ).toEqual({
      id: 'row-1',
      action: 'webhook.created',
      metadata: { url: 'https://example.test' },
      ip_address: '10.0.0.9',
      created_at: '2026-03-04T05:06:07.000Z',
    });
  });

  test('normalises absent metadata and IP to null', () => {
    const row = serializeActivity({
      id: 'row-2',
      action: 'user.blocked',
      metadata: null,
      ipAddress: null,
      createdAt: new Date(0),
    });
    expect(row.metadata).toBeNull();
    expect(row.ip_address).toBeNull();
  });

  test('never leaks the raw username of the row', () => {
    const row = serializeActivity({
      id: 'row-3',
      action: 'user.registered',
      username: 'ada*localhost',
      createdAt: new Date(0),
    });
    expect(row).not.toHaveProperty('username');
  });
});

describe('ACTIVITY_ACTIONS', () => {
  test('covers the events the issue asks to be logged', () => {
    expect(Object.values(ACTIVITY_ACTIONS)).toEqual(
      expect.arrayContaining([
        'user.registered',
        'user.blocked',
        'webhook.created',
        'webhook.deleted',
      ]),
    );
  });

  test('uses a stable dotted namespace', () => {
    for (const action of Object.values(ACTIVITY_ACTIONS)) {
      expect(action).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});

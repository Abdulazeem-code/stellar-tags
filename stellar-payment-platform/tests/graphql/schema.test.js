'use strict';

/**
 * #685 — Schema construction.
 *
 * Guards the two things that break silently if they regress: the SDL compiling
 * at all (a type error would otherwise only surface on the first request), and
 * credentials staying off the wire.
 */

jest.mock('../../src/db', () => ({ poolGet: jest.fn() }));

const { makeSchema, attachResolvers, serializeDateTime, parseDateTimeInput } = require('../../src/graphql/schema');
const { typeDefs } = require('../../src/graphql/typeDefs');
const resolvers = require('../../src/graphql/resolvers');

const build = () => makeSchema({ typeDefs, resolvers });

describe('GraphQL schema', () => {
  it('compiles the SDL', () => {
    const schema = build();
    expect(schema).toBeTruthy();
    expect(schema.getQueryType().name).toBe('Query');
  });

  it('exposes the dashboard read surface', () => {
    const fields = build().getQueryType().getFields();
    for (const name of [
      'user',
      'userByAddress',
      'users',
      'webhooks',
      'payments',
      'paymentIntents',
      'activity',
      'federation',
      'platformStats',
      'routingStats',
      'health',
    ]) {
      expect(fields[name]).toBeDefined();
    }
  });

  it('keeps the webhook signing secret off the schema', () => {
    const webhookFields = build().getType('Webhook').getFields();
    expect(webhookFields.url).toBeDefined();
    expect(webhookFields.secret).toBeUndefined();
  });

  it('never exposes an API key hash', () => {
    const schema = build();
    expect(schema.getType('ApiKey')).toBeUndefined();
  });

  it('grafts resolvers onto the compiled fields', () => {
    const fields = build().getQueryType().getFields();
    expect(typeof fields.users.resolve).toBe('function');
    expect(typeof build().getType('User').getFields().webhooks.resolve).toBe('function');
  });

  it('rejects an SDL that does not typecheck', () => {
    expect(() => makeSchema({ typeDefs: 'type Query { user: NotARealType }' })).toThrow();
  });

  it('warns instead of throwing when a resolver names a field that is gone', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = makeSchema({
      typeDefs: 'type Query { hello: String }',
      scalars: {},
      resolvers: { Query: { hello: () => 'hi', missingField: () => 'nope' } },
    });

    expect(schema.getQueryType().getFields().hello.resolve).toBeInstanceOf(Function);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missingField'));
    warn.mockRestore();
  });

  it('ignores resolver entries for unknown types', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = makeSchema({
      typeDefs: 'type Query { hello: String }',
      scalars: {},
      resolvers: { Ghost: { hello: () => 'x' } },
    });

    expect(schema.getQueryType().getFields().hello.resolve).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ghost'));
    warn.mockRestore();
  });

  it('leaves fields the resolver map does not mention on the default resolver', () => {
    const schema = makeSchema({
      typeDefs: 'type Query { hello: String }',
      scalars: {},
      resolvers: { Query: {} },
    });

    expect(schema.getQueryType().getFields().hello.resolve).toBeUndefined();
  });
});

describe('DateTime scalar', () => {
  it('serialises a Date to ISO-8601', () => {
    const date = new Date('2026-03-04T05:06:07.008Z');
    expect(serializeDateTime(date)).toBe('2026-03-04T05:06:07.008Z');
  });

  it('passes an already-formatted string through', () => {
    expect(serializeDateTime('2026-03-04T05:06:07.008Z')).toBe('2026-03-04T05:06:07.008Z');
  });

  it('serialises null and undefined to null', () => {
    expect(serializeDateTime(null)).toBeNull();
    expect(serializeDateTime(undefined)).toBeNull();
  });

  it('returns null for an invalid Date rather than throwing', () => {
    expect(serializeDateTime(new Date('nope'))).toBeNull();
  });

  it('parses a valid input to a Date', () => {
    expect(parseDateTimeInput('2026-01-02')).toEqual(new Date('2026-01-02'));
  });

  it('throws on an unparseable input', () => {
    expect(() => parseDateTimeInput('not-a-date')).toThrow(TypeError);
  });
});

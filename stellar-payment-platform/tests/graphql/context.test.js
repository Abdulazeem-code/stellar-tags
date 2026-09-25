'use strict';

/**
 * #685 — Identity for the GraphQL endpoint.
 *
 * The endpoint is public for reads, so a bad token must not fail a query; it
 * just means there is no viewer. The interesting cases are the ones where a
 * resolver asks "is this you?", because that is where a wrong answer would
 * expose someone else's webhooks or activity.
 */

jest.mock('../../src/services/ownershipService', () => ({
  authenticateUsernameOwner: jest.fn(async () => ({
    username: 'alice*localhost',
    address: 'G_ALICE_ADDRESS',
  })),
  verifyFreighterSignedMessage: jest.fn(),
}));

jest.mock('../../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  httpLogger: jest.fn(),
}));

jest.mock('../../src/utils/jwt', () => ({ verifyToken: jest.fn() }));

const { verifyToken } = require('../../src/utils/jwt');
const { authenticateUsernameOwner } = require('../../src/services/ownershipService');
const { createContext, resolveViewer, viewerUsername, requireUsernameOwner } = require('../../src/graphql/context');
const { createFakePrisma } = require('./support/fakePrisma');

const req = (headers = {}) => ({ headers });

const context = (headers = {}) => createContext({ req: req(headers), prisma: createFakePrisma({}) });

beforeEach(() => {
  jest.clearAllMocks();
  verifyToken.mockReset();
  verifyToken.mockImplementation(() => ({}));
  authenticateUsernameOwner.mockReset();
  authenticateUsernameOwner.mockImplementation(async () => ({
    username: 'alice*localhost',
    address: 'G_ALICE_ADDRESS',
  }));
});

describe('resolveViewer', () => {
  it('is null for an anonymous request', () => {
    expect(resolveViewer(req())).toBeNull();
  });

  it('verifies a Bearer token', () => {
    verifyToken.mockReturnValue({ username: 'alice*localhost' });

    const viewer = resolveViewer(req({ authorization: 'Bearer a.b.c' }));

    expect(verifyToken).toHaveBeenCalledWith('a.b.c');
    expect(viewer).toEqual({ claims: { username: 'alice*localhost' } });
  });

  it('accepts the scheme in any case', () => {
    verifyToken.mockReturnValue({ username: 'alice*localhost' });

    expect(resolveViewer(req({ authorization: 'bearer a.b.c' }))).not.toBeNull();
    expect(resolveViewer(req({ authorization: 'BEARER a.b.c' }))).not.toBeNull();
  });

  it('treats an unverifiable token as no token rather than an error', () => {
    verifyToken.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    expect(resolveViewer(req({ authorization: 'Bearer expired' }))).toBeNull();
  });

  it('ignores a non-Bearer Authorization header', () => {
    expect(resolveViewer(req({ authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('trims the token, so a stray trailing space is not fatal', () => {
    verifyToken.mockReturnValue({ username: 'alice*localhost' });

    expect(resolveViewer(req({ authorization: 'Bearer  a.b.c ' }))).not.toBeNull();
    expect(verifyToken).toHaveBeenCalledWith('a.b.c');
  });
});

describe('viewerUsername', () => {
  it('prefers username, then preferred_username, then sub', () => {
    expect(viewerUsername({ claims: { username: 'a', preferred_username: 'b', sub: 'c' } })).toBe('a');
    expect(viewerUsername({ claims: { preferred_username: 'b', sub: 'c' } })).toBe('b');
    expect(viewerUsername({ claims: { sub: 'c' } })).toBe('c');
  });

  it('is null when no claim names a user', () => {
    expect(viewerUsername(null)).toBeNull();
    expect(viewerUsername({ claims: {} })).toBeNull();
    expect(viewerUsername({ claims: { username: '   ' } })).toBeNull();
  });
});

describe('requireUsernameOwner', () => {
  const call = (headers, username, operation = 'webhook') =>
    requireUsernameOwner(context(headers), username, operation);

  it('rejects an empty username before doing any work', async () => {
    await expect(call({}, '')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(authenticateUsernameOwner).not.toHaveBeenCalled();
  });

  it('accepts a JWT naming the same account, in any case', async () => {
    verifyToken.mockReturnValue({ username: 'Alice*localhost', address: 'G_ALICE_ADDRESS' });

    await expect(call({ authorization: 'Bearer t' }, 'alice')).resolves.toEqual({
      username: 'alice*localhost',
      address: 'G_ALICE_ADDRESS',
    });
    expect(authenticateUsernameOwner).not.toHaveBeenCalled();
  });

  it('refuses a JWT for a different account', async () => {
    verifyToken.mockReturnValue({ username: 'alice*localhost' });

    await expect(call({ authorization: 'Bearer t' }, 'bob')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not treat a token-less request as forbidden', async () => {
    await expect(call({}, 'alice')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('delegates to the shared signature check', async () => {
    const result = await call(
      { 'x-stellar-signature': 'GSIG', 'x-stellar-signer': 'GSIGNER' },
      'alice',
      'webhook',
    );

    expect(authenticateUsernameOwner).toHaveBeenCalledWith({
      username: 'alice',
      signature: 'GSIG',
      signerAddress: 'GSIGNER',
      operation: 'webhook',
    });
    expect(result.username).toBe('alice*localhost');
  });

  it('passes no signer for the account-key form of the signature', async () => {
    await call({ 'x-stellar-signature': 'GACCOUNT_KEY' }, 'alice', 'activity');

    expect(authenticateUsernameOwner).toHaveBeenCalledWith(
      expect.objectContaining({ signature: 'GACCOUNT_KEY', signerAddress: undefined, operation: 'activity' }),
    );
  });

  it('surfaces the ownership service verdict', async () => {
    authenticateUsernameOwner.mockRejectedValue(
      Object.assign(new Error('Signature verification failed'), { statusCode: 401 }),
    );

    await expect(
      call({ 'x-stellar-signature': 'GSIG' }, 'alice'),
    ).rejects.toThrow('Signature verification failed');
  });
});

describe('createContext', () => {
  it('carries the request dependencies and fresh loaders', () => {
    const prisma = createFakePrisma({});
    const poolGet = jest.fn();
    const redisClient = { get: jest.fn() };

    const ctx = createContext({ req: req(), prisma, redisClient, poolGet });

    expect(ctx.prisma).toBe(prisma);
    expect(ctx.redisClient).toBe(redisClient);
    expect(ctx.poolGet).toBe(poolGet);
    expect(ctx.loaders.userByUsername).toBeDefined();
  });

  it('does not share loader caches between requests', async () => {
    const prisma = createFakePrisma({
      users: [{ username: 'alice*localhost', address: 'G_ALICE_ADDRESS', createdAt: new Date() }],
    });

    await createContext({ req: req(), prisma }).loaders.userByUsername.load('alice*localhost');
    await createContext({ req: req(), prisma }).loaders.userByUsername.load('alice*localhost');

    expect(prisma.__callsTo('user', 'findMany')).toHaveLength(2);
  });

  it('reads the correlation id from the header', () => {
    expect(context({ 'x-correlation-id': 'abc-123' }).correlationId).toBe('abc-123');
    expect(context().correlationId).toBeNull();
  });

  it('exposes the ownership hooks as methods', () => {
    const ctx = context();

    expect(typeof ctx.requireUsernameOwner).toBe('function');
    expect(typeof ctx.requireWebhookOwnerUsername).toBe('function');
  });
});

describe('requireWebhookOwnerUsername', () => {
  it('prefers the header, so the signed payload names the account', () => {
    verifyToken.mockReturnValue({ username: 'alice*localhost' });
    const ctx = context({
      'x-stellar-tags-username': 'bob',
      authorization: 'Bearer t',
    });

    expect(ctx.requireWebhookOwnerUsername(ctx)).toBe('bob');
  });

  it('falls back to the token', () => {
    verifyToken.mockReturnValue({ username: 'alice*localhost' });
    const ctx = context({ authorization: 'Bearer t' });

    expect(ctx.requireWebhookOwnerUsername(ctx)).toBe('alice*localhost');
  });

  it('demands something to go on', () => {
    const ctx = context();

    expect(() => ctx.requireWebhookOwnerUsername(ctx)).toThrow(/X-Stellar-Tags-Username/);
  });
});

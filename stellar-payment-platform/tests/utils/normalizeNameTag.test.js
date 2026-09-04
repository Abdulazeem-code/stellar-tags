// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) }
}));

// Mock Prisma so it doesn't try to connect to a real database and crash
jest.mock('../../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((ops) => Promise.all(ops)),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  }
}));

const { normalizeNameTag } = require('../../server');

describe('normalizeNameTag', () => {
  describe('empty strings', () => {
    it('returns an empty string for an empty input', () => {
      expect(normalizeNameTag('')).toBe('');
    });

    it('returns an empty string for whitespace-only input', () => {
      expect(normalizeNameTag('   ')).toBe('');
      expect(normalizeNameTag('\t\n  ')).toBe('');
    });

    it('returns an empty string for non-string inputs', () => {
      expect(normalizeNameTag(null)).toBe('');
      expect(normalizeNameTag(undefined)).toBe('');
      expect(normalizeNameTag(123)).toBe('');
    });
  });

  describe('strings already containing *', () => {
    it('returns the trimmed string unchanged when it already contains a domain separator', () => {
      expect(normalizeNameTag('client*localhost')).toBe('client*localhost');
      expect(normalizeNameTag('lekan*localhost')).toBe('lekan*localhost');
    });

    it('trims surrounding whitespace before returning a federation-style name', () => {
      expect(normalizeNameTag('  user*example.com  ')).toBe('user*example.com');
    });

    it('does not append *localhost to a string that already has a domain', () => {
      expect(normalizeNameTag('alice*stellar.org')).toBe('alice*stellar.org');
    });
  });

  describe('standard strings', () => {
    it('appends *localhost to a plain username', () => {
      expect(normalizeNameTag('client')).toBe('client*localhost');
    });

    it('trims surrounding whitespace before appending *localhost', () => {
      expect(normalizeNameTag('  alice  ')).toBe('alice*localhost');
    });

    it('preserves the casing of the username when appending *localhost', () => {
      expect(normalizeNameTag('Alice')).toBe('Alice*localhost');
    });
  });
});

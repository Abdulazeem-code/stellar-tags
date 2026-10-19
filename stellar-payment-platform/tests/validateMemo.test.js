// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) }
}));

// Mock Prisma so it doesn't try to connect to a real database and crash
jest.mock('../prismaClient', () => ({
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

const { validateMemo } = require('../server');

describe('validateMemo', () => {
  it('returns null if both memoType and memo are absent', () => {
    expect(validateMemo(undefined, undefined)).toBeNull();
    expect(validateMemo(null, null)).toBeNull();
    expect(validateMemo('', '')).toBeNull();
  });

  it('returns error if memoType is present but memo is absent', () => {
    expect(validateMemo('text', undefined)).toBe('memo is required when memo_type is provided.');
    expect(validateMemo('id', null)).toBe('memo is required when memo_type is provided.');
    expect(validateMemo('hash', '')).toBe('memo is required when memo_type is provided.');
  });

  it('returns error if memo is present but memoType is absent', () => {
    expect(validateMemo(undefined, '123')).toBe('memo_type is required when memo is provided.');
    expect(validateMemo(null, 'abc')).toBe('memo_type is required when memo is provided.');
    expect(validateMemo('', 'test')).toBe('memo_type is required when memo is provided.');
  });

  it('returns error if memoType is invalid', () => {
    expect(validateMemo('invalid_type', 'test')).toBe('memo_type must be one of: text, id, hash.');
    expect(validateMemo('number', '123')).toBe('memo_type must be one of: text, id, hash.');
  });

  describe('memo_type: text', () => {
    it('returns null for valid text memo (<= 28 bytes)', () => {
      expect(validateMemo('text', 'hello world')).toBeNull();
      expect(validateMemo('text', 'a'.repeat(28))).toBeNull();
    });

    it('returns error for text memo exceeding 28 bytes', () => {
      expect(validateMemo('text', 'a'.repeat(29))).toBe('memo of type text must not exceed 28 bytes.');
    });

    it('returns error for text memo exceeding 28 bytes', () => {
      // 'abcd' is 4 bytes. 7 of them = 28 bytes (valid), 8 = 32 bytes (invalid)
      expect(validateMemo('text', 'abcd'.repeat(7))).toBeNull();
      expect(validateMemo('text', 'abcd'.repeat(8))).toBe('memo of type text must not exceed 28 bytes.');
    });
  });

  describe('memo_type: id', () => {
    it('returns null for valid id memo (<= 64-bit unsigned integer)', () => {
      expect(validateMemo('id', '1234567890')).toBeNull();
      expect(validateMemo('id', '18446744073709551615')).toBeNull(); // Max uint64
      expect(validateMemo('id', '0')).toBeNull();
    });

    it('returns error for id memo exceeding max uint64', () => {
      expect(validateMemo('id', '18446744073709551616')).toBe('memo of type id must be a valid 64-bit unsigned integer.');
    });

    it('returns error for id memo containing non-numeric characters', () => {
      expect(validateMemo('id', '123a')).toBe('memo of type id must be a valid 64-bit unsigned integer.');
      expect(validateMemo('id', '-1')).toBe('memo of type id must be a valid 64-bit unsigned integer.');
      expect(validateMemo('id', '123.45')).toBe('memo of type id must be a valid 64-bit unsigned integer.');
      expect(validateMemo('id', ' 123')).toBe('memo of type id must be a valid 64-bit unsigned integer.');
    });
  });

  describe('memo_type: hash', () => {
    it('returns null for valid hash memo (64 hex characters)', () => {
      const validHash = 'a'.repeat(64);
      expect(validateMemo('hash', validHash)).toBeNull();
      const validHashUpper = 'A'.repeat(64);
      expect(validateMemo('hash', validHashUpper)).toBeNull();
      const validHashMixed = '0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF';
      expect(validateMemo('hash', validHashMixed)).toBeNull();
    });

    it('returns error for hash memo with invalid length', () => {
      expect(validateMemo('hash', 'a'.repeat(63))).toBe('memo of type hash must be a 64-character hex string (32 bytes).');
      expect(validateMemo('hash', 'a'.repeat(65))).toBe('memo of type hash must be a 64-character hex string (32 bytes).');
    });

    it('returns error for hash memo with invalid characters', () => {
      const invalidHash = 'g'.repeat(64); // 'g' is not hex
      expect(validateMemo('hash', invalidHash)).toBe('memo of type hash must be a 64-character hex string (32 bytes).');
    });
  });
});

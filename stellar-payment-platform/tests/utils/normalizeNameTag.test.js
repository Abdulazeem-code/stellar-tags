'use strict';

/**
 * Unit tests for `normalizeNameTag` (Abdulazeem-code/stellar-tags#239).
 *
 * `normalizeNameTag` turns a bare username into a federation address by
 * appending the default federation domain (e.g. `alice` -> `alice*localhost`).
 * Values that are empty or already carry a `*` must be handled explicitly.
 */
const { normalizeNameTag } = require('../../src/utils');

describe('normalizeNameTag', () => {
  describe('standard strings', () => {
    test('appends the default federation domain to a bare username', () => {
      expect(normalizeNameTag('alice')).toBe('alice*localhost');
    });

    test('trims surrounding whitespace before appending the domain', () => {
      expect(normalizeNameTag('  alice  ')).toBe('alice*localhost');
      expect(normalizeNameTag('\talice\n')).toBe('alice*localhost');
    });

    test('appends the domain without validating the local part', () => {
      // Preserve the helper's existing behaviour: it only formats, it does not
      // reject characters here.
      expect(normalizeNameTag('a.b-c_1')).toBe('a.b-c_1*localhost');
    });
  });

  describe('strings already containing a federation separator', () => {
    test('returns a fully-qualified address unchanged', () => {
      expect(normalizeNameTag('alice*example.com')).toBe('alice*example.com');
    });

    test('returns a value ending in a bare asterisk unchanged', () => {
      expect(normalizeNameTag('alice*')).toBe('alice*');
    });

    test('returns a leading-asterisk value unchanged', () => {
      expect(normalizeNameTag('*localhost')).toBe('*localhost');
    });

    test('does not append the domain when an asterisk appears anywhere', () => {
      expect(normalizeNameTag('a*b*c')).toBe('a*b*c');
    });

    test('trims before deciding the value already carries an asterisk', () => {
      expect(normalizeNameTag('  alice*example.com  ')).toBe('alice*example.com');
    });
  });

  describe('empty and non-string input', () => {
    test('returns an empty string for an empty string', () => {
      expect(normalizeNameTag('')).toBe('');
    });

    test('returns an empty string for whitespace-only input', () => {
      expect(normalizeNameTag('   ')).toBe('');
      expect(normalizeNameTag('\t\n')).toBe('');
    });

    test.each([undefined, null, 0, 42, {}, [], true, false])(
      'returns an empty string for non-string input %p',
      (value) => {
        expect(normalizeNameTag(value)).toBe('');
      },
    );
  });
});

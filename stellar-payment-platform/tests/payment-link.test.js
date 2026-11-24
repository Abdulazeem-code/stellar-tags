'use strict';

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    isValidEd25519PublicKey: (value) =>
      typeof value === 'string' && /^G[A-Z2-7]{55}$/.test(value),
  },
}));

const { ApiError } = require('../src/errors');
const {
  buildPaymentLink,
  parsePaymentLink,
  toSep7Uri,
} = require('../src/utils/paymentLink');

const ISSUER = `G${'A'.repeat(55)}`;

describe('payment link utilities', () => {
  test('build and parse round-trip all valid fields', () => {
    const input = {
      baseUrl: 'https://stellar.example',
      tag: 'alice',
      amount: '12.3456789'.slice(0, 10),
      asset: `USDC:${ISSUER}`,
      memo: 'invoice-42',
      memoType: 'text',
      requestId: 'request-1',
    };
    const link = buildPaymentLink(input);
    expect(parsePaymentLink(link)).toEqual({
      tag: 'alice*localhost',
      amount: input.amount,
      asset: input.asset,
      memo: input.memo,
      memoType: input.memoType,
      requestId: input.requestId,
    });
  });

  test('supports native XLM and normalized tags', () => {
    const link = buildPaymentLink({
      baseUrl: 'https://stellar.example',
      tag: 'alice*example.com',
      amount: '10',
      asset: 'native',
    });
    expect(parsePaymentLink(link)).toMatchObject({
      tag: 'alice*localhost',
      amount: '10',
      asset: 'XLM',
    });
  });

  test.each(['0', '-1', '1.12345678', 'abc', '1e3', 10])(
    'rejects invalid amount %p',
    (amount) => {
      expect(() => buildPaymentLink({
        baseUrl: 'https://stellar.example',
        tag: 'alice',
        amount,
      })).toThrow(ApiError);
    },
  );

  test('rejects bad assets and issuers', () => {
    expect(() => buildPaymentLink({
      baseUrl: 'https://stellar.example',
      tag: 'alice',
      amount: '10',
      asset: 'USDC',
    })).toThrow(ApiError);
    expect(() => buildPaymentLink({
      baseUrl: 'https://stellar.example',
      tag: 'alice',
      amount: '10',
      asset: 'USDC:GBAD',
    })).toThrow(ApiError);
  });

  test('rejects bad memo combinations', () => {
    expect(() => buildPaymentLink({
      baseUrl: 'https://stellar.example',
      tag: 'alice',
      amount: '10',
      memoType: 'text',
    })).toThrow(ApiError);
    expect(() => buildPaymentLink({
      baseUrl: 'https://stellar.example',
      tag: 'alice',
      amount: '10',
      memo: '123',
    })).toThrow(ApiError);
  });

  test('rejects invalid base URL and link paths', () => {
    expect(() => buildPaymentLink({
      baseUrl: 'http://example.com',
      tag: 'alice',
      amount: '10',
    })).toThrow(ApiError);
    expect(() => parsePaymentLink('https://example.com/not-pay/alice?amount=10')).toThrow(ApiError);
    expect(() => parsePaymentLink('not a url')).toThrow(ApiError);
  });

  test('builds SEP-7 native and issued asset URIs', () => {
    expect(toSep7Uri({
      destination: ISSUER,
      amount: '10',
    })).toBe(`web+stellar:pay?destination=${ISSUER}&amount=10`);

    const uri = toSep7Uri({
      destination: ISSUER,
      amount: '10',
      asset: `USDC:${ISSUER}`,
      memo: 'invoice-42',
      memoType: 'text',
    });
    expect(uri).toContain(`destination=${ISSUER}`);
    expect(uri).toContain('asset_code=USDC');
    expect(uri).toContain(`asset_issuer=${ISSUER}`);
    expect(uri).toContain('memo=invoice-42');
    expect(uri).toContain('memo_type=MEMO_TEXT');
  });

  test('uses SEP-7 memo type names and base64 for hash memos', () => {
    const params = (uri) => new URLSearchParams(uri.slice('web+stellar:pay?'.length));
    const hex = 'ab'.repeat(32);

    const id = params(toSep7Uri({ destination: ISSUER, amount: '1', memo: '42', memoType: 'id' }));
    expect(id.get('memo_type')).toBe('MEMO_ID');
    expect(id.get('memo')).toBe('42');

    const hash = params(toSep7Uri({ destination: ISSUER, amount: '1', memo: hex, memoType: 'hash' }));
    expect(hash.get('memo_type')).toBe('MEMO_HASH');
    expect(hash.get('memo')).toBe(Buffer.from(hex, 'hex').toString('base64'));
  });

  test('validates SEP-7 destination and memo', () => {
    expect(() => toSep7Uri({
      destination: 'GBAD',
      amount: '10',
    })).toThrow(ApiError);
    expect(() => toSep7Uri({
      destination: ISSUER,
      amount: '10',
      memoType: 'hash',
      memo: 'bad',
    })).toThrow(ApiError);
  });

  test('rejects malformed tags, assets, amounts and memo fields in parsed links', () => {
    expect(() => parsePaymentLink('https://example.com/pay/%')).toThrow(ApiError);
    expect(() => parsePaymentLink('https://example.com/pay/alice')).toThrow(ApiError);
    expect(() => parsePaymentLink('https://example.com/pay/alice?amount=10&asset=NOPE')).toThrow(ApiError);
    expect(() => parsePaymentLink(
      `https://example.com/pay/alice?amount=10&asset=USDC:${ISSUER}&memo=invoice`,
    )).toThrow(ApiError);
  });

  test('rejects malformed asset codes and memo type without memo', () => {
    expect(() => buildPaymentLink({
      baseUrl: 'https://stellar.example',
      tag: 'alice',
      amount: '10',
      asset: `!@:${ISSUER}`,
    })).toThrow(ApiError);
    expect(() => buildPaymentLink({
      baseUrl: 'https://stellar.example',
      tag: 'alice',
      amount: '10',
      memoType: 'number',
      memo: '123',
    })).toThrow(ApiError);
  });
});

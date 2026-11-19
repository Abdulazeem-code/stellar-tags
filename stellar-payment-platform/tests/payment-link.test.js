'use strict';

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    isValidEd25519PublicKey: (value) =>
      typeof value === 'string' && /^G[A-Z2-7]{55}$/.test(value),
  },
}));

const {
  buildPaymentLink,
  parsePaymentLink,
  toSep7Uri,
} = require('../src/utils/paymentLink');

const ISSUER = `G${'A'.repeat(55)}`;

describe('payment link utilities', () => {
  test('build and parse preserve valid payment fields', () => {
    const input = {
      baseUrl: 'https://example.com',
      tag: 'alice',
      amount: '12.3456789'.slice(0, 10),
      asset: `USDC:${ISSUER}`,
      memo: 'invoice-42',
      memoType: 'text',
      requestId: 'request-1',
    };
    const link = buildPaymentLink(input);
    expect(parsePaymentLink(link)).toMatchObject({
      tag: 'alice*localhost',
      amount: input.amount,
      asset: input.asset,
      memo: input.memo,
      memoType: input.memoType,
      requestId: input.requestId,
    });
  });

  test('rejects invalid amount and asset', () => {
    expect(() => buildPaymentLink({
      baseUrl: 'https://example.com',
      tag: 'alice',
      amount: '0',
    })).toThrow();
    expect(() => buildPaymentLink({
      baseUrl: 'https://example.com',
      tag: 'alice',
      amount: '10',
      asset: `USDC:Gbad`,
    })).toThrow();
  });

  test('builds native and issued SEP-7 URIs', () => {
    expect(toSep7Uri({
      destination: ISSUER,
      amount: '10',
    })).toContain('web+stellar:pay');
    expect(toSep7Uri({
      destination: ISSUER,
      amount: '10',
      asset: `USDC:${ISSUER}`,
      memo: 'invoice-42',
      memoType: 'text',
    })).toContain('asset_code=USDC');
  });
});

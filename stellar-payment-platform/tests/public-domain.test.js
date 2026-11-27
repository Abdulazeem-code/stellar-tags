'use strict';

const {
  federationServerUrl,
  servedFederationDomains,
  storedAliasOf,
  hostnameOf,
} = require('../src/utils/publicDomain');

const reqWithHost = (host) => ({ get: (name) => (name.toLowerCase() === 'host' ? host : undefined) });

describe('hostnameOf', () => {
  test.each([
    ['example.com', 'example.com'],
    ['Example.COM', 'example.com'],
    ['https://example.com/federation', 'example.com'],
    ['example.com:8443', 'example.com'],
    ['', ''],
    [undefined, ''],
  ])('%p -> %p', (input, expected) => {
    expect(hostnameOf(input)).toBe(expected);
  });
});

describe('federationServerUrl', () => {
  test('FEDERATION_SERVER_URL wins', () => {
    expect(
      federationServerUrl(reqWithHost('api.example.com'), {
        FEDERATION_SERVER_URL: 'https://fed.example.com/x',
        STELLAR_TAG_DOMAIN: 'tags.example.com',
      }),
    ).toBe('https://fed.example.com/x');
  });

  test('then STELLAR_TAG_DOMAIN, with or without a scheme', () => {
    expect(federationServerUrl(reqWithHost('api.example.com'), { STELLAR_TAG_DOMAIN: 'tags.example.com' }))
      .toBe('https://tags.example.com/federation');
    expect(federationServerUrl(reqWithHost('api.example.com'), { STELLAR_TAG_DOMAIN: 'https://tags.example.com/' }))
      .toBe('https://tags.example.com/federation');
  });

  test('then the request host, never "undefined"', () => {
    expect(federationServerUrl(reqWithHost('stellar-tags.onrender.com'), {}))
      .toBe('https://stellar-tags.onrender.com/federation');
    expect(federationServerUrl(reqWithHost(undefined), {})).toBe('http://localhost/federation');
  });

  test('local hosts use http', () => {
    expect(federationServerUrl(reqWithHost('localhost:5000'), {})).toBe('http://localhost:5000/federation');
    expect(federationServerUrl(reqWithHost('127.0.0.1:5000'), {})).toBe('http://127.0.0.1:5000/federation');
  });
});

describe('servedFederationDomains', () => {
  test('includes the stored default, the configured domains and the request host', () => {
    const domains = servedFederationDomains(reqWithHost('stellar-tags.onrender.com'), {
      STELLAR_TAG_DOMAIN: 'tags.example.com',
      FEDERATION_SERVER_URL: 'https://fed.example.com/federation',
    });
    expect([...domains].sort()).toEqual(
      ['fed.example.com', 'localhost', 'stellar-tags.onrender.com', 'tags.example.com'].sort(),
    );
  });
});

describe('storedAliasOf', () => {
  const req = reqWithHost('stellar-tags.onrender.com');

  test('maps a tag on a served domain to the stored localhost form', () => {
    expect(storedAliasOf('alice*stellar-tags.onrender.com', req, {})).toBe('alice*localhost');
    expect(storedAliasOf('alice*tags.example.com', req, { STELLAR_TAG_DOMAIN: 'tags.example.com' }))
      .toBe('alice*localhost');
  });

  test('does not alias the stored domain itself, unknown domains or malformed tags', () => {
    expect(storedAliasOf('alice*localhost', req, {})).toBeNull();
    expect(storedAliasOf('alice*someone-else.example', req, {})).toBeNull();
    expect(storedAliasOf('alice', req, {})).toBeNull();
    expect(storedAliasOf('*stellar-tags.onrender.com', req, {})).toBeNull();
  });
});

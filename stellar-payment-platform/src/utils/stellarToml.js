'use strict';

/**
 * Renders the body of GET /.well-known/stellar.toml.
 *
 * Kept as a pure function so the disabled document can be regression-tested
 * byte-for-byte and the enabled document can be parsed with a TOML parser.
 */
function buildStellarToml({ federationServerUrl, domain, sep10 } = {}) {
  let toml = `FEDERATION_SERVER="${federationServerUrl || `https://${domain}/federation`}"\n`;

  if (sep10 && sep10.enabled) {
    // Quoted basic strings: the passphrase contains spaces and semicolons,
    // both of which are only legal inside quotes in TOML.
    toml += `NETWORK_PASSPHRASE="${sep10.networkPassphrase}"\n`;
    toml += `SIGNING_KEY="${sep10.signingKey}"\n`;
    toml += `WEB_AUTH_ENDPOINT="${sep10.webAuthEndpoint}"\n`;
  }

  return toml;
}

module.exports = { buildStellarToml };

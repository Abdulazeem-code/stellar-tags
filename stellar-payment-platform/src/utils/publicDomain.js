'use strict';

/**
 * Which domain this API answers for, for SEP-1 (stellar.toml) and SEP-2
 * (federation).
 *
 * STELLAR_TAG_DOMAIN wins when set. Without it the API used to publish
 * FEDERATION_SERVER="https://undefined/federation"; now it falls back to the
 * host the request came in on, which on Render is the service's own domain.
 *
 * Tags are stored as `name*localhost` (DEFAULT_FEDERATION_DOMAIN). A wallet
 * resolving `name*stellar-tags.onrender.com` must still find them, so
 * federation treats every domain this API serves as an alias of the stored
 * default domain. Unrelated domains are not aliased.
 */

const { DEFAULT_FEDERATION_DOMAIN } = require('../utils');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Lower-case hostname (no scheme, port or path) of a domain or URL, or ''. */
const hostnameOf = (value) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const text = value.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** host[:port] of the incoming request, from the Host header. */
const requestHost = (req) => {
  const host = req && typeof req.get === 'function' ? req.get('host') : '';
  return typeof host === 'string' ? host.trim().toLowerCase() : '';
};

/**
 * The FEDERATION_SERVER URL to publish in stellar.toml.
 * @param {import('express').Request} req
 * @param {NodeJS.ProcessEnv} [env]
 */
const federationServerUrl = (req, env = process.env) => {
  if (env.FEDERATION_SERVER_URL) return env.FEDERATION_SERVER_URL;
  const configured = env.STELLAR_TAG_DOMAIN && env.STELLAR_TAG_DOMAIN.trim();
  const host = configured
    ? configured.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '')
    : requestHost(req) || 'localhost';
  // Local development is plain HTTP; everything public is HTTPS.
  const scheme = LOCAL_HOSTS.has(hostnameOf(host)) ? 'http' : 'https';
  return `${scheme}://${host}/federation`;
};

/**
 * Every domain whose federation addresses this API resolves.
 * @returns {Set<string>} lower-case hostnames
 */
const servedFederationDomains = (req, env = process.env) =>
  new Set(
    [
      DEFAULT_FEDERATION_DOMAIN,
      hostnameOf(env.STELLAR_TAG_DOMAIN),
      hostnameOf(env.FEDERATION_SERVER_URL),
      hostnameOf(requestHost(req)),
    ].filter(Boolean),
  );

/**
 * For `name*domain` on a domain this API serves (other than the stored
 * default), the stored form `name*<default domain>`; otherwise null.
 * @param {string} nameTag lower-case `name*domain`
 */
const storedAliasOf = (nameTag, req, env = process.env) => {
  const star = typeof nameTag === 'string' ? nameTag.lastIndexOf('*') : -1;
  if (star <= 0) return null;
  const local = nameTag.slice(0, star);
  const domain = nameTag.slice(star + 1).toLowerCase();
  if (!domain || domain === DEFAULT_FEDERATION_DOMAIN) return null;
  if (!servedFederationDomains(req, env).has(domain)) return null;
  return `${local}*${DEFAULT_FEDERATION_DOMAIN}`;
};

module.exports = {
  federationServerUrl,
  servedFederationDomains,
  storedAliasOf,
  hostnameOf,
};

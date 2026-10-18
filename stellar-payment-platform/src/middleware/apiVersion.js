'use strict';

const SUPPORTED_VERSIONS = ['v1', 'v2'];

const DEFAULT_VERSION = 'v1';

const fromUri = (req) => {
  const match = req.path.match(/^\/api\/(v[0-9]+)(?:\/|$)/);
  if (!match) return null;
  const version = match[1].toLowerCase();
  return SUPPORTED_VERSIONS.includes(version) ? version : null;
};

const fromHeader = (req) => {
  const raw = req.get('api-version') || req.get('accept-version');
  if (!raw) return null;
  const version = raw.trim().toLowerCase();
  return SUPPORTED_VERSIONS.includes(version) ? version : null;
};

const apiVersion = (req, res, next) => {
  req.apiVersion = fromUri(req) || fromHeader(req) || DEFAULT_VERSION;
  next();
};

module.exports = { apiVersion, fromUri, fromHeader, SUPPORTED_VERSIONS, DEFAULT_VERSION };
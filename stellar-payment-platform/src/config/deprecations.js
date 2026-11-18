'use strict';

/**
 * Deprecation registry (RFC 8594).
 *
 * Each entry describes an endpoint that is scheduled for removal. The
 * deprecation middleware reads this list and attaches `Deprecation`,
 * `Sunset` and `Link` headers to matching requests, while also emitting a
 * server-side warning so the deprecation is observable in logs.
 *
 * Entry shape:
 *   method         HTTP method (uppercase) or '*' to match any method.
 *   path           Request path as seen by Express. May contain a single
 *                 '*' wildcard that matches any trailing segment(s), e.g.
 *                 '/api/v1/receipts/*' matches '/api/v1/receipts/abc123'.
 *   deprecatedSince ISO-8601 date the endpoint became deprecated. Surfaces
 *                 in the `Deprecation` header.
 *   sunset         ISO-8601 date the endpoint will be removed. Surfaces in
 *                 the `Sunset` header.
 *   replacement    (optional) Path of the endpoint consumers should migrate
 *                 to. Used in the server-side log message.
 *   documentation  (optional) URL describing the deprecation/migration.
 *                 Surfaces in the `Link` header with rel="deprecation".
 */

const DEPRECATIONS = [
  {
    method: 'GET',
    path: '/api/v1/lookup',
    deprecatedSince: '2026-08-29',
    sunset: '2027-02-28',
    replacement: '/api/v2/lookup',
    documentation: 'https://docs.stellar-tags.example/deprecations/lookup',
  },
  {
    method: 'GET',
    path: '/api/v1/stats',
    deprecatedSince: '2026-08-29',
    sunset: '2027-01-31',
    replacement: '/api/v2/stats',
    documentation: 'https://docs.stellar-tags.example/deprecations/stats',
  },
  {
    method: 'POST',
    path: '/api/v1/payments/bulk',
    deprecatedSince: '2026-08-29',
    sunset: '2027-03-31',
    replacement: '/api/v2/payments/bulk',
    documentation: 'https://docs.stellar-tags.example/deprecations/bulk-payments',
  },
];

module.exports = { DEPRECATIONS };

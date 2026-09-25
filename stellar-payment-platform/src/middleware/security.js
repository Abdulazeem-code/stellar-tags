'use strict';

/**
 * src/middleware/security.js
 *
 * Security headers middleware configured with strict Content Security Policy (CSP)
 * to deny all framing, restrict script/style sources, and remove identifying headers.
 */

const helmet = require('helmet');

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:', 'https:'],
  fontSrc: ["'self'"],
  objectSrc: ["'none'"],
  mediaSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

const securityMiddleware = helmet({
  contentSecurityPolicy: {
    directives: cspDirectives,
  },
  frameguard: {
    action: 'deny',
  },
  hidePoweredBy: true,
  referrerPolicy: {
    policy: 'no-referrer',
  },
  xContentTypeOptions: true,
});

module.exports = {
  securityMiddleware,
  cspDirectives,
};

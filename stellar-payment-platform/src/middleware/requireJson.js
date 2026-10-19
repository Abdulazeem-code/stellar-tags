'use strict';

const { ApiError } = require('../errors');

/**
 * Rejects requests that are not JSON before schema validation runs. Without a
 * parsed JSON body every field would report as missing, which would mask the
 * real problem behind a list of spurious field errors.
 */
const requireJson = (req, res, next) => {
  if (!req.is('application/json')) {
    return next(
      new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported Media Type. Please send application/json'),
    );
  }
  return next();
};

module.exports = { requireJson };

'use strict';

/**
 * Wraps an async route handler or middleware to catch unhandled promise rejections
 * and pass them to the Express error handler via next(err).
 * 
 * @param {Function} fn - The async Express handler function
 * @returns {Function} Express middleware/handler function
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { asyncHandler };

/**
 * db.js — Legacy shim retained for the etagCache middleware and utility
 * re-exports. All database interactions have been migrated to Prisma Client.
 * The raw PostgreSQL pool helpers (poolGet, poolRun, poolAll) have been
 * removed as part of issue #724 (Migrate to Prisma ORM from Raw Queries/Knex).
 */
const crypto = require('crypto');
const { logger } = require('./logger');

const { USER_DATABASE, normalizeNameTag } = require('./utils');

/**
 * ETag caching middleware. Computes a SHA-256 hash of every JSON response
 * body and sets the ETag header. If the client sends a matching If-None-Match
 * header the response is short-circuited with 304 Not Modified.
 */
const etagCache = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const bodyString = JSON.stringify(body);
    const hash = crypto.createHash('sha256').update(bodyString).digest('hex');
    const etag = `"${hash}"`;

    res.set('ETag', etag);

    const clientEtag = req.get('If-None-Match');
    if (clientEtag && clientEtag === etag) {
      return res.status(304).end();
    }

    return originalJson(body);
  };

  next();
};

module.exports = {
  USER_DATABASE,
  normalizeNameTag,
  etagCache,
};

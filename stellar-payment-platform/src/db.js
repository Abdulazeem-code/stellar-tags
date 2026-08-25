const crypto = require('crypto');
const { Pool } = require('pg');
const { logger } = require('./logger');
const dotenv = require('dotenv');

dotenv.config();

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  logger.error(err, 'Unexpected PostgreSQL pool error');
});

const poolGet = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
};

const poolRun = async (sql, params = []) => {
  const result = await pool.query(sql, params);
  return { changes: result.rowCount, lastID: result.rows[0]?.id };
};

const poolAll = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows;
};

const { USER_DATABASE, normalizeNameTag } = require('./utils');

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
  poolGet,
  poolRun,
  poolAll,
  pool,
  USER_DATABASE,
  normalizeNameTag,
  etagCache
};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const sqlite3 = require('sqlite3').verbose();
const genericPool = require('generic-pool');
const { scheduleCleanupJob } = require('./cleanup-cron');
const dotenv = require('dotenv');

dotenv.config();

const rawDbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'registrations.db');

const parseDbPath = (raw) => {
  const [filePath, queryString] = raw.split('?');
  const params = {};
  if (queryString) {
    queryString.split('&').forEach((pair) => {
      const [key, value] = pair.split('=');
      params[key] = value;
    });
  }
  return {
    filePath,
    connectionLimit: parseInt(params.connection_limit, 10) || 10,
    poolTimeout: parseInt(params.pool_timeout, 10) || 5,
  };
};

const dbConfig = parseDbPath(rawDbPath);
fs.mkdirSync(path.dirname(dbConfig.filePath), { recursive: true });

const attachAsyncDbMethods = (db) => {
  if (typeof db.get === 'function') {
    db.getAsync = promisify(db.get.bind(db));
  }
  if (typeof db.run === 'function') {
    db.runAsync = promisify(db.run.bind(db));
  }
  if (typeof db.all === 'function') {
    db.allAsync = promisify(db.all.bind(db));
  }
  return db;
};

const getAsync = async (db, sql, params = []) => {
  if (typeof db.getAsync === 'function') {
    return db.getAsync(sql, params);
  }
  return promisify(db.get.bind(db))(sql, params);
};

const runAsync = async (db, sql, params = []) => {
  if (typeof db.runAsync === 'function') {
    return db.runAsync(sql, params);
  }
  return promisify(db.run.bind(db))(sql, params);
};

const allAsync = async (db, sql, params = []) => {
  if (typeof db.allAsync === 'function') {
    return db.allAsync(sql, params);
  }
  return promisify(db.all.bind(db))(sql, params);
};

const dbPool = genericPool.createPool(
  {
    create: () =>
      new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(dbConfig.filePath, (err) => {
          if (err) return reject(err);
          attachAsyncDbMethods(connection);
          connection.runAsync('PRAGMA journal_mode=WAL')
            .then(() => resolve(connection))
            .catch(reject);
        });
      }),
    destroy: (connection) =>
      new Promise((resolve) => {
        connection.close(() => resolve());
      }),
  },
  {
    max: dbConfig.connectionLimit,
    min: 1,
    acquireTimeoutMillis: dbConfig.poolTimeout * 1000,
    idleTimeoutMillis: 30000,
  },
);

const poolGet = (sql, params) =>
  dbPool.acquire().then(async (conn) => {
    try {
      return await getAsync(conn, sql, params);
    } finally {
      dbPool.release(conn);
    }
  });

const poolRun = (sql, params) =>
  dbPool.acquire().then(async (conn) => {
    try {
      return await runAsync(conn, sql, params);
    } finally {
      dbPool.release(conn);
    }
  });

const poolAll = (sql, params) =>
  dbPool.acquire().then(async (conn) => {
    try {
      return await allAsync(conn, sql, params);
    } finally {
      dbPool.release(conn);
    }
  });

(async () => {
  try {
    await poolRun(
      `CREATE TABLE IF NOT EXISTS username_registry (
        username TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      [],
    );
    console.log(`Database pool initialised — max ${dbConfig.connectionLimit} connections, ${dbConfig.poolTimeout}s timeout`);
  } catch (err) {
    console.error('Failed to initialise database schema:', err);
    process.exit(1);
  }
})();

const USER_DATABASE = {
  'client*localhost': 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
  'lekan*localhost': 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
};

const DEFAULT_FEDERATION_DOMAIN = 'localhost';

const normalizeNameTag = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return '';
  }
  return trimmed.includes('*') ? trimmed : `${trimmed}*${DEFAULT_FEDERATION_DOMAIN}`;
};

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'registrations.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = attachAsyncDbMethods(new sqlite3.Database(dbPath));

(async () => {
  try {
    await db.runAsync(
      `CREATE TABLE IF NOT EXISTS username_registry (
        username TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    );
  } catch (err) {
    console.error('Failed to initialize direct database schema:', err);
  }
})();

// Start the weekly background job that prunes/flags stale registrations.
scheduleCleanupJob(db);

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
  dbPool,
  USER_DATABASE,
  normalizeNameTag,
  etagCache
};

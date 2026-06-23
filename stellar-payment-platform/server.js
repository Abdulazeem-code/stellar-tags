const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { z } = require('zod');

const stellarAddress = z.string().regex(/^G[A-Z2-7]{55}$/, 'Must be a valid Stellar Ed25519 public key (starts with G, 56 chars)');

const registerSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9]{3,18}$/, 'Username must be 3-18 alphanumeric characters'),
  address: stellarAddress,
});

const lookupSchema = z.object({
  address: stellarAddress,
});

const app = express();
const PORT = process.env.PORT || 5000;


app.use(cors());
app.use(express.json());

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

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'registrations.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS username_registry (
      username TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );
});

app.get('/federation', (req, res) => {
  const nameTag = normalizeNameTag(req.query.q);

  if (!nameTag) {
    return res.status(400).json({ detail: "Missing 'q' parameter" });
  }

  db.get(
    'SELECT address FROM username_registry WHERE username = ?',
    [nameTag],
    (error, row) => {
      if (error) {
        return res.status(500).json({ detail: 'Database lookup failed' });
      }

      const address = row?.address || USER_DATABASE[nameTag];
      if (!address) {
        return res.status(404).json({ detail: 'Name tag not found' });
      }

      return res.json({
        stellar_address: address,
        account_id: address,
        memo_type: 'text',
        memo: 'PlatformPayment',
      });
    },
  );
});

app.post('/register', (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ detail: parsed.error.errors.map((e) => `${e.path[0]}: ${e.message}`).join('; ') });
  }

  const username = normalizeNameTag(parsed.data.username);
  const address = parsed.data.address;

  db.get(
    'SELECT username FROM username_registry WHERE address = ?',
    [address],
    (lookupError, row) => {
      if (lookupError) {
        return res.status(500).json({ detail: 'Database lookup failed' });
      }

      if (row) {
        return res.status(409).json({ detail: 'Address already registered' });
      }

      db.run(
        'INSERT INTO username_registry (username, address, created_at) VALUES (?, ?, ?)',
        [username, address, new Date().toISOString()],
        (error) => {
          if (error) {
            if (error.message && error.message.includes('UNIQUE')) {
              return res.status(409).json({ detail: 'Username already registered' });
            }

            return res.status(500).json({ detail: 'Failed to save registration' });
          }

          return res.json({ ok: true, username, address });
        },
      );
    },
  );
});

app.get('/lookup', (req, res) => {
  const parsed = lookupSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ detail: parsed.error.errors.map((e) => `${e.path[0]}: ${e.message}`).join('; ') });
  }

  const address = parsed.data.address;

  db.get(
    'SELECT username FROM username_registry WHERE address = ?',
    [address],
    (error, row) => {
      if (error) {
        return res.status(500).json({ detail: 'Database lookup failed' });
      }

      if (!row) {
        return res.status(404).json({ detail: 'Username not found for this address' });
      }

      return res.json({ username: row.username, address });
    },
  );
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

if (require.main === module) {
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server successfully initialized on port ${PORT}`);
    });

    // This catches any weird cloud port errors and prevents a hard crash
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is in use, forcing shutdown so Railway can restart cleanly.`);
            process.exit(1);
        }
    });
}

#!/usr/bin/env node

/**
 * Script to export seeded usernames and addresses for k6 load testing.
 *
 * If a database connection (DATABASE_URL) is present via Prisma, it exports live
 * records from the database.
 * If running without a live DB connection, it derives the deterministic seed
 * usernames and addresses identical to scripts/seed.js so load tests can run
 * out of the box.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USER_COUNT = 50;
const FIRST_NAMES = [
  'ada', 'bello', 'chidi', 'dalia', 'emeka', 'farida', 'gwen', 'hassan',
  'imani', 'juno', 'kemi', 'lars', 'mira', 'nadia', 'olu', 'priya',
  'quinn', 'rosa', 'sami', 'tunde', 'uma', 'viktor', 'wren', 'zora',
];

const LAST_NAMES = [
  'abiola', 'bergman', 'castillo', 'diallo', 'eriksen', 'fontaine', 'garcia',
  'haddad', 'ibrahim', 'jensen', 'kowalski', 'lindqvist', 'mensah', 'novak',
  'okafor', 'pereira', 'quintero', 'rahman', 'silva', 'takahashi', 'ustinov',
  'varga', 'whitfield', 'zhang',
];

function deriveDeterministicSeedUsers() {
  const users = [];
  const domain = process.env.STELLAR_TAGS_DOMAIN || 'localhost';

  for (let i = 0; i < USER_COUNT; i++) {
    const fn = FIRST_NAMES[i % FIRST_NAMES.length];
    const ln = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
    const username = `${fn}.${ln}`;

    // Deterministic 56-char Stellar G... address
    const hash = crypto.createHash('sha256').update(`seed-addr-${i}`).digest('hex').toUpperCase();
    // Base32 RFC4648 uppercase characters (excluding 0, 1, 8, 9)
    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let base32 = 'G';
    for (let c = 0; c < 55; c++) {
      base32 += base32Chars[parseInt(hash.slice((c % 64), (c % 64) + 1), 16) % base32Chars.length];
    }

    users.push({
      username: `${username}*${domain}`,
      address: base32,
    });
  }

  return users;
}

async function exportFromDbOrSeed() {
  const outputUsernamesFile = path.join(__dirname, 'usernames.txt');
  const outputAddressesFile = path.join(__dirname, 'addresses.txt');

  let exportedUsers = [];

  // Attempt database query if prisma is available
  try {
    const prismaPath = path.resolve(__dirname, '../stellar-payment-platform/prismaClient.js');
    if (fs.existsSync(prismaPath) && process.env.DATABASE_URL) {
      const { prisma } = require(prismaPath);
      const dbUsers = await prisma.user.findMany({
        where: { deletedAt: null },
        select: { username: true, address: true },
        take: 200,
      });
      if (dbUsers && dbUsers.length > 0) {
        exportedUsers = dbUsers;
        console.log(`Exported ${exportedUsers.length} records from local database.`);
      }
    }
  } catch {
    // Database connection not available or not configured
  }

  // Fallback to deterministic seed generator
  if (exportedUsers.length === 0) {
    exportedUsers = deriveDeterministicSeedUsers();
    console.log(`Generated ${exportedUsers.length} deterministic seed records.`);
  }

  const usernames = exportedUsers.map((u) => u.username).join('\n') + '\n';
  const addresses = exportedUsers.map((u) => u.address).join('\n') + '\n';

  fs.writeFileSync(outputUsernamesFile, usernames, 'utf8');
  fs.writeFileSync(outputAddressesFile, addresses, 'utf8');

  console.log(`Wrote ${outputUsernamesFile}`);
  console.log(`Wrote ${outputAddressesFile}`);
}

exportFromDbOrSeed().catch((err) => {
  console.error('Error generating seed lists:', err);
  process.exit(1);
});

const { faker } = require('@faker-js/faker');
const { StrKey } = require('@stellar/stellar-sdk');
require('dotenv').config();

const { prisma } = require('../prismaClient');
const logger = require('../logger');

const DEFAULT_FEDERATION_DOMAIN = 'localhost';
const SEED_COUNT = 50;

// Generate a valid Stellar public key
const generateStellarPublicKey = () => {
  // Generate a random 32-byte seed and convert to Ed25519 public key
  const seed = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    seed[i] = Math.floor(Math.random() * 256);
  }
  return StrKey.encodeEd25519PublicKey(seed);
};

// Generate a realistic username
const generateUsername = () => {
  const firstName = faker.person.firstName().toLowerCase();
  const lastName = faker.person.lastName().toLowerCase();
  const number = faker.number.int({ min: 1, max: 9999 });
  return `${firstName}.${lastName}${number}`;
};

// Normalize username to include domain
const normalizeNameTag = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return '';
  }
  return trimmed.includes('*') ? trimmed : `${trimmed}*${DEFAULT_FEDERATION_DOMAIN}`;
};

const seedDatabase = async () => {
  try {
    logger.info({ seedCount: SEED_COUNT }, 'Starting database seeding');

    let inserted = 0;
    let skipped = 0;

    for (let i = 0; i < SEED_COUNT; i++) {
      const username = normalizeNameTag(generateUsername()).toLowerCase();
      const address = generateStellarPublicKey();
      const createdAt = faker.date.past({ years: 1 });

      try {
        await prisma.user.create({
          data: { username, address, createdAt },
        });
        inserted++;
        logger.debug({ username, address }, 'Inserted');
      } catch (error) {
        if (error.code === 'P2002') {
          skipped++;
          logger.debug({ username }, 'Skipped duplicate');
        } else {
          logger.error({ username, err: error.message }, 'Insert failed');
        }
      }
    }

    const count = await prisma.user.count();
    logger.info({ total: SEED_COUNT, inserted, skipped, dbCount: count }, 'Seeding complete');
  } catch (error) {
    logger.fatal({ err: error }, 'Fatal error during seeding');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

seedDatabase();

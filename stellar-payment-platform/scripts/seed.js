const { faker } = require('@faker-js/faker');
const { StrKey } = require('@stellar/stellar-sdk');
require('dotenv').config();

const { prisma } = require('../prismaClient');
const { logger } = require('../src/logger');

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
    logger.info('Starting database seeding...');
    logger.info(`Generating ${SEED_COUNT} mock entries...`);

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
        logger.info(`✓ Inserted: ${username} -> ${address}`);
      } catch (error) {
        // P2002 — unique constraint violation (duplicate username or address)
        if (error.code === 'P2002') {
          skipped++;
          logger.info(`⊘ Skipped (duplicate): ${username}`);
        } else {
          logger.error(`✗ Error inserting ${username}:`, error.message);
        }
      }
    }

    logger.info('\n=== Seeding Complete ===');
    logger.info(`Total entries generated: ${SEED_COUNT}`);
    logger.info(`Successfully inserted: ${inserted}`);
    logger.info(`Skipped (duplicates): ${skipped}`);

    const count = await prisma.user.count();
    logger.info(`Total entries in database: ${count}`);
  } catch (error) {
    logger.error('Fatal error during seeding:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

seedDatabase();

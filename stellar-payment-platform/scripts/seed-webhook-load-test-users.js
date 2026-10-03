// Provisions Stellar-keypair-backed test users for the webhook load test
// (artillery-webhooks.yml). Each user's secret key is written to a local
// fixture so the Artillery processor can sign requests the same way a real
// Freighter wallet would (see verifyFreighterSignedMessage in webhookRoutes.js).
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Keypair } = require('@stellar/stellar-sdk');
const { prisma } = require('../prismaClient');
const { logger } = require('../src/logger');

const USER_COUNT = Number(process.env.LOAD_TEST_USER_COUNT || 50);
const FEDERATION_DOMAIN = process.env.FEDERATION_DOMAIN || 'localhost';
const OUTPUT_PATH = path.join(__dirname, '.load-test-fixtures', 'webhook-users.json');

const seedWebhookLoadTestUsers = async () => {
  const users = [];

  for (let i = 0; i < USER_COUNT; i++) {
    const keypair = Keypair.random();
    const username = `webhook-load-${i}*${FEDERATION_DOMAIN}`;
    const address = keypair.publicKey();

    await prisma.user.upsert({
      where: { username },
      update: { address },
      create: { username, address },
    });

    users.push({ username, address, secret: keypair.secret() });
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(users, null, 2));
  logger.info(`[seed-webhook-load-test-users] Wrote ${users.length} users to ${OUTPUT_PATH}`);
};

seedWebhookLoadTestUsers()
  .catch((err) => {
    logger.error('[seed-webhook-load-test-users] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

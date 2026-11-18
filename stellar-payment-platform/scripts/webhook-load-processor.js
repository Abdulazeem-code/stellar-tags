// Artillery processor for artillery-webhooks.yml. Signs each virtual user's
// requests the way a Freighter wallet would (see verifyFreighterSignedMessage
// in src/routes/v1/webhookRoutes.js), so the load test exercises the real
// signature-verification path rather than a stubbed-out auth check.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Keypair } = require('@stellar/stellar-sdk');

const FIXTURE_PATH = path.join(__dirname, '.load-test-fixtures', 'webhook-users.json');
const SIGNED_MESSAGE_PREFIX = Buffer.from('Stellar Signed Message:\n', 'utf8');
const MOCK_RECEIVER_URL = process.env.MOCK_RECEIVER_URL || 'http://localhost:5099';

let users;
try {
  users = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
} catch {
  throw new Error(
    `Missing load-test fixtures at ${FIXTURE_PATH}. Run "node scripts/seed-webhook-load-test-users.js" first.`,
  );
}

// Every webhook route authenticates with the same "webhook:<username>"
// message (see authenticateWebhookCall), so one signature per VU covers
// register, test-delivery, list, and delete.
function assignTestUser(context, events, done) {
  const user = users[Math.floor(Math.random() * users.length)];
  const message = `webhook:${user.username}`;
  const hash = crypto
    .createHash('sha256')
    .update(Buffer.concat([SIGNED_MESSAGE_PREFIX, Buffer.from(message, 'utf8')]))
    .digest();

  context.vars.username = user.username;
  context.vars.signerAddress = user.address;
  context.vars.signature = Keypair.fromSecret(user.secret).sign(hash).toString('base64');
  context.vars.webhookUrl = `${MOCK_RECEIVER_URL}/sink/${context.vars.$uuid}`;

  return done();
}

module.exports = { assignTestUser };

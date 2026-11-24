require('dotenv').config();
const { getConfig } = require('./config');
const { createBot } = require('./bot');

async function main() {
  const config = getConfig();

  if (!config.discordToken) {
    console.error('ERROR: DISCORD_TOKEN is not set in environment or .env file.');
    console.error('Please configure your bot token from the Discord Developer Portal.');
    process.exit(1);
  }

  console.log('Starting Stellar Tags Discord Bot...');
  console.log(`- API Base: ${config.apiBase}`);
  console.log(`- Default Domain: ${config.domain}`);
  console.log(`- Stellar Network: ${config.network}`);

  const client = createBot(config);

  client.once('ready', () => {
    console.log(`Discord bot logged in as ${client.user.tag}! Ready to handle /resolve, /pay, and /help.`);
  });

  process.once('SIGINT', () => {
    client.destroy();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    client.destroy();
    process.exit(0);
  });

  await client.login(config.discordToken);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error starting bot:', err);
    process.exit(1);
  });
}

module.exports = { main };

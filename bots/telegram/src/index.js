require('dotenv').config();
const { getConfig } = require('./config');
const { createBot } = require('./bot');

async function main() {
  const config = getConfig();

  if (!config.telegramBotToken) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN is not set in environment or .env file.');
    console.error('Please configure your bot token from @BotFather.');
    process.exit(1);
  }

  console.log('Starting Stellar Tags Telegram Bot...');
  console.log(`- API Base: ${config.apiBase}`);
  console.log(`- Default Domain: ${config.domain}`);
  console.log(`- Stellar Network: ${config.network}`);

  const bot = createBot(config);

  bot.catch((err) => {
    console.error('Error occurred in bot handler:', err);
  });

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop());
  process.once('SIGTERM', () => bot.stop());

  await bot.start({
    onStart: (botInfo) => {
      console.log(`Bot started successfully as @${botInfo.username}`);
    },
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error starting bot:', err);
    process.exit(1);
  });
}

module.exports = { main };

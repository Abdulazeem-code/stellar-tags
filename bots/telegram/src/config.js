/**
 * Configuration module loading and validating environment variables.
 */

function getConfig() {
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    apiBase: (process.env.STELLAR_TAGS_API_BASE || 'http://localhost:3000').replace(/\/+$/, ''),
    domain: process.env.STELLAR_TAGS_DOMAIN || 'stellar-tags.org',
    network: (process.env.NETWORK || 'testnet').toLowerCase(),
  };
}

module.exports = {
  getConfig,
};

/**
 * Discord bot configuration loader
 */

function getConfig() {
  return {
    discordToken: process.env.DISCORD_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    guildId: process.env.DISCORD_GUILD_ID || '',
    apiBase: (process.env.STELLAR_TAGS_API_BASE || 'http://localhost:3000').replace(/\/+$/, ''),
    domain: process.env.STELLAR_TAGS_DOMAIN || 'stellar-tags.org',
    network: (process.env.NETWORK || 'testnet').toLowerCase(),
  };
}

module.exports = {
  getConfig,
};

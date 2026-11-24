const { Client, GatewayIntentBits, Collection } = require('discord.js');
const resolveCommand = require('./commands/resolve');
const payCommand = require('./commands/pay');
const helpCommand = require('./commands/help');

/**
 * Creates and initializes the Discord Client instance.
 * @param {object} config
 * @param {object} [deps]
 * @returns {Client}
 */
function createBot(config, deps = {}) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.commands = new Collection();
  client.commands.set(resolveCommand.data.name, resolveCommand);
  client.commands.set(payCommand.data.name, payCommand);
  client.commands.set(helpCommand.data.name, helpCommand);

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, config, deps);
    } catch (error) {
      console.error(`Error executing /${interaction.commandName}:`, error);
      const errorMessage = 'There was an error while executing this command!';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMessage, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
      }
    }
  });

  return client;
}

module.exports = {
  createBot,
};

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { getConfig } = require('../src/config');
const resolveCommand = require('../src/commands/resolve');
const payCommand = require('../src/commands/pay');
const helpCommand = require('../src/commands/help');

async function deploy() {
  const config = getConfig();

  if (!config.discordToken || !config.clientId) {
    console.error('ERROR: DISCORD_TOKEN and DISCORD_CLIENT_ID must be set to register slash commands.');
    process.exit(1);
  }

  const commands = [
    resolveCommand.data.toJSON(),
    payCommand.data.toJSON(),
    helpCommand.data.toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    let route;
    if (config.guildId) {
      console.log(`Registering commands to Guild ID: ${config.guildId}`);
      route = Routes.applicationGuildCommands(config.clientId, config.guildId);
    } else {
      console.log('Registering commands globally to Application.');
      route = Routes.applicationCommands(config.clientId);
    }

    const data = await rest.put(route, { body: commands });
    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    console.error('Error deploying slash commands:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  deploy();
}

module.exports = { deploy };

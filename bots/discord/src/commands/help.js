const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show help and instructions for the Stellar Tags Discord Bot')
    .addBooleanOption((option) =>
      option
        .setName('public')
        .setDescription('Set to true to post help publicly in the channel (default: false, ephemeral)')
        .setRequired(false),
    ),

  /**
   * Executes the /help slash command
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {object} config
   */
  async execute(interaction, config) {
    const isPublic = interaction.options.getBoolean('public') ?? false;

    const embed = new EmbedBuilder()
      .setTitle('🌟 Stellar Tags Discord Bot')
      .setColor(0x5865f2)
      .setDescription(
        'Resolve Stellar Tags and generate SEP-0007 payment links without leaving Discord!\n\n' +
        'All payments use **client-side signing** through your own wallet. The bot never requests, stores, or holds private keys.',
      )
      .addFields(
        {
          name: '🔍 `/resolve tag:<tag> [public:<true|false>]`',
          value:
            'Looks up the Stellar account ID, shortened address, and attached memo for a tag.\n' +
            '*Example:* `/resolve tag:alice` or `/resolve tag:alice*stellar-tags.org`',
        },
        {
          name: '💳 `/pay tag:<tag> amount:<n> [asset:<asset>] [public:<true|false>]`',
          value:
            'Generates a clickable SEP-0007 payment link and QR code.\n' +
            '*Example:* `/pay tag:alice amount:10`\n' +
            '*Example:* `/pay tag:bob amount:5.5 asset:USDC public:true`\n' +
            '*Example:* `/pay tag:carol amount:20 asset:EURC:GA5Z...`',
        },
        {
          name: 'ℹ️ Ephemeral vs Public Replies',
          value:
            'By default, bot replies are **ephemeral** (only visible to you). Add `public:true` to share the resolution or payment link with the entire channel.',
        },
      )
      .setFooter({ text: `Stellar Tags • Network: ${config.network}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: !isPublic });
  },
};

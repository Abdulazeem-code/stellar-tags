const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { resolveTag, shortenAddress } = require('../services/federation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resolve')
    .setDescription('Look up the Stellar account and memo for a Stellar Tag')
    .addStringOption((option) =>
      option
        .setName('tag')
        .setDescription('The Stellar tag to resolve (e.g. alice or alice*stellar-tags.org)')
        .setRequired(true),
    )
    .addBooleanOption((option) =>
      option
        .setName('public')
        .setDescription('Set to true to show response publicly to everyone in the channel (default: false, ephemeral)')
        .setRequired(false),
    ),

  /**
   * Executes the /resolve slash command
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {object} config
   * @param {object} [deps]
   */
  async execute(interaction, config, deps = {}) {
    const isPublic = interaction.options.getBoolean('public') ?? false;
    await interaction.deferReply({ ephemeral: !isPublic });

    const tag = interaction.options.getString('tag', true).trim();
    const resolveFn = deps.resolveTag || resolveTag;

    try {
      const resolved = await resolveFn(tag, config);
      const shortened = shortenAddress(resolved.stellarAddress);

      const embed = new EmbedBuilder()
        .setTitle(`🔍 Resolved Stellar Tag: ${tag}`)
        .setColor(0x00ae86)
        .addFields(
          { name: 'Short Address', value: `\`${shortened}\``, inline: true },
          { name: 'Memo', value: resolved.memo ? `\`${resolved.memo}\` (${resolved.memoType || 'text'})` : '_None_', inline: true },
          { name: 'Full Stellar Account ID', value: `\`${resolved.stellarAddress}\``, inline: false },
        )
        .setFooter({ text: `Federation Service • Network: ${config.network}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      const errorEmbed = new EmbedBuilder().setColor(0xed4245);

      if (err.code === 'TAG_NOT_FOUND') {
        errorEmbed
          .setTitle('❌ Tag Not Found')
          .setDescription(`Tag \`${tag}\` was not found. Please verify the tag name or domain.`);
      } else if (err.code === 'TAG_BLOCKED') {
        errorEmbed
          .setTitle('🚫 Tag Blocked')
          .setDescription(`Tag \`${tag}\` is blocked or suspended.`);
      } else if (err.code === 'SERVICE_UNAVAILABLE') {
        errorEmbed
          .setTitle('🔌 Service Unavailable')
          .setDescription('The federation lookup service is currently unreachable. Please try again later.');
      } else {
        errorEmbed
          .setTitle('⚠️ Resolution Failed')
          .setDescription(err.message || 'An unexpected error occurred while resolving the tag.');
      }

      await interaction.editReply({ embeds: [errorEmbed] });
    }
  },
};

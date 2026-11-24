const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { resolveTag, shortenAddress } = require('../services/federation');
const { buildSep7PayUri, validateAmount, parseAsset } = require('../services/sep7');
const { generateQrBuffer } = require('../services/qr');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Generate a SEP-0007 payment link and QR code to pay a Stellar Tag')
    .addStringOption((option) =>
      option
        .setName('tag')
        .setDescription('The Stellar tag to pay (e.g. alice or alice*stellar-tags.org)')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('amount')
        .setDescription('Amount to pay (e.g. 10 or 1.5, positive number, max 7 decimal places)')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('asset')
        .setDescription('Asset code (e.g. XLM, USDC, or CODE:ISSUER; defaults to XLM)')
        .setRequired(false),
    )
    .addBooleanOption((option) =>
      option
        .setName('public')
        .setDescription('Set to true to show payment request publicly to the channel (default: false, ephemeral)')
        .setRequired(false),
    ),

  /**
   * Executes the /pay slash command
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {object} config
   * @param {object} [deps]
   */
  async execute(interaction, config, deps = {}) {
    const isPublic = interaction.options.getBoolean('public') ?? false;
    await interaction.deferReply({ ephemeral: !isPublic });

    const tag = interaction.options.getString('tag', true).trim();
    const amountRaw = interaction.options.getString('amount', true).trim();
    const assetRaw = interaction.options.getString('asset')?.trim();

    // 1. Validate Amount
    const amountVal = validateAmount(amountRaw);
    if (!amountVal.valid) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Invalid Amount')
        .setDescription(amountVal.error);
      return await interaction.editReply({ embeds: [errorEmbed] });
    }

    // 2. Validate Asset
    const assetVal = parseAsset(assetRaw);
    if (!assetVal.valid) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Invalid Asset')
        .setDescription(assetVal.error);
      return await interaction.editReply({ embeds: [errorEmbed] });
    }

    const resolveFn = deps.resolveTag || resolveTag;
    const qrFn = deps.generateQrBuffer || generateQrBuffer;

    try {
      // 3. Resolve Tag
      const resolved = await resolveFn(tag, config);

      // 4. Build SEP-7 URI
      const sep7Uri = buildSep7PayUri({
        destination: resolved.accountId,
        amount: amountVal.normalized,
        asset: assetRaw,
        memo: resolved.memo,
        memoType: resolved.memoType,
        network: config.network,
      });

      // 5. Generate QR Code
      const qrBuffer = await qrFn(sep7Uri);
      const attachment = new AttachmentBuilder(qrBuffer, { name: 'sep7-payment-qr.png' });

      const displayAsset = assetVal.assetCode || 'XLM';
      const embed = new EmbedBuilder()
        .setTitle(`Payment Request for ${tag}`)
        .setColor(0x5865f2)
        .setDescription(
          `Click below to open the transaction directly in your Stellar wallet, or scan the QR code with a SEP-0007 compatible mobile wallet (Freighter, LOBSTR, Albedo).\n\n` +
          `[Open in Stellar Wallet](${sep7Uri})\n\n` +
          `\`${sep7Uri}\``,
        )
        .addFields(
          { name: 'Amount', value: `\`${amountVal.normalized} ${displayAsset}\``, inline: true },
          { name: 'Recipient', value: `\`${shortenAddress(resolved.stellarAddress)}\``, inline: true },
          { name: 'Network', value: `\`${config.network}\``, inline: true },
        )
        .setImage('attachment://sep7-payment-qr.png')
        .setFooter({ text: 'Client-side signing • The bot never holds keys or touches funds.' })
        .setTimestamp();

      if (resolved.memo) {
        embed.addFields({
          name: `Memo (${resolved.memoType || 'text'})`,
          value: `\`${resolved.memo}\``,
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (err) {
      const errorEmbed = new EmbedBuilder().setColor(0xed4245);

      if (err.code === 'TAG_NOT_FOUND') {
        errorEmbed
          .setTitle('Tag Not Found')
          .setDescription(`Tag \`${tag}\` was not found. Cannot generate payment request.`);
      } else if (err.code === 'TAG_BLOCKED') {
        errorEmbed
          .setTitle('Tag Blocked')
          .setDescription(`Tag \`${tag}\` is blocked. Payments to this recipient are disabled.`);
      } else if (err.code === 'SERVICE_UNAVAILABLE') {
        errorEmbed
          .setTitle('Service Unavailable')
          .setDescription('The federation API is currently unreachable. Please try again later.');
      } else {
        errorEmbed
          .setTitle('Payment Generation Failed')
          .setDescription(err.message || 'An unexpected error occurred while generating payment URI.');
      }

      await interaction.editReply({ embeds: [errorEmbed] });
    }
  },
};

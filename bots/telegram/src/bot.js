const { Bot, InputFile } = require('grammy');
const { resolveTag, shortenAddress } = require('./services/federation');
const { buildSep7PayUri, validateAmount, parseAsset } = require('./services/sep7');
const { generateQrBuffer } = require('./services/qr');

const HELP_MESSAGE = `*Stellar Tags Bot* 🌟
Pay or resolve Stellar Tags directly from Telegram!

*Commands:*
• /resolve \`<tag>\` — Look up the Stellar account and memo for a tag.
  Example: \`/resolve alice\` or \`/resolve alice*stellar-tags.org\`

• /pay \`<tag>\` \`<amount>\` \`[asset]\` — Generate a SEP-0007 payment URI and QR code.
  Example: \`/pay alice 10\` (pays 10 XLM)
  Example: \`/pay alice 5.5 USDC\` (pays 5.5 USDC)
  Example: \`/pay alice 50 EURC:GDQ4...\` (issued asset with issuer)

• /help — Show this help message.

_Note: This bot never holds private keys or signs transactions. All payments are signed safely in your own Stellar wallet._`;

/**
 * Creates and configures the Telegram Bot instance.
 * @param {object} config
 * @param {object} [deps] - Optional dependency overrides for testing
 * @returns {Bot}
 */
function createBot(config, deps = {}) {
  const token = config.telegramBotToken || 'DUMMY_TOKEN_FOR_TEST';
  const botInfo = deps.botInfo || (config.telegramBotToken ? undefined : {
    id: 123456789,
    is_bot: true,
    first_name: 'StellarTagsBot',
    username: 'StellarTagsBot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  });

  const bot = new Bot(token, botInfo ? { botInfo } : undefined);

  const resolveFn = deps.resolveTag || resolveTag;
  const qrFn = deps.generateQrBuffer || generateQrBuffer;

  // /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(HELP_MESSAGE, { parse_mode: 'Markdown' });
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_MESSAGE, { parse_mode: 'Markdown' });
  });

  // /resolve <tag> command
  bot.command('resolve', async (ctx) => {
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/).slice(1);

    if (parts.length === 0 || !parts[0]) {
      return ctx.reply('⚠️ Please provide a tag to resolve.\nUsage: `/resolve <tag>`\nExample: `/resolve alice`', {
        parse_mode: 'Markdown',
      });
    }

    const tag = parts[0];

    try {
      const resolved = await resolveFn(tag, config);
      const shortened = shortenAddress(resolved.stellarAddress);

      let reply = `🔍 *Resolved Stellar Tag:* \`${tag}\`\n\n`;
      reply += `• *Address:* \`${shortened}\`\n`;
      reply += `• *Full Account ID:*\n\`${resolved.stellarAddress}\`\n`;

      if (resolved.memo) {
        reply += `• *Memo (${resolved.memoType || 'text'}):* \`${resolved.memo}\`\n`;
      } else {
        reply += `• *Memo:* _None_\n`;
      }

      await ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch (err) {
      if (err.code === 'TAG_NOT_FOUND') {
        return ctx.reply(`❌ Tag \`${tag}\` was not found. Please check spelling or verify the tag exists.`, {
          parse_mode: 'Markdown',
        });
      }
      if (err.code === 'TAG_BLOCKED') {
        return ctx.reply(`🚫 Tag \`${tag}\` is blocked or suspended.`, {
          parse_mode: 'Markdown',
        });
      }
      if (err.code === 'SERVICE_UNAVAILABLE') {
        return ctx.reply(`🔌 Federation API service is currently unavailable. Please try again later.`, {
          parse_mode: 'Markdown',
        });
      }
      return ctx.reply(`⚠️ Failed to resolve tag: ${err.message || 'Unknown error'}`);
    }
  });

  // /pay <tag> <amount> [asset] command
  bot.command('pay', async (ctx) => {
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/).slice(1);

    if (parts.length < 2) {
      return ctx.reply(
        '⚠️ Missing arguments.\nUsage: `/pay <tag> <amount> [asset]`\nExample: `/pay alice 10` or `/pay bob 25 USDC`',
        { parse_mode: 'Markdown' },
      );
    }

    const [tag, amountRaw, assetRaw] = parts;

    // Validate amount
    const amountVal = validateAmount(amountRaw);
    if (!amountVal.valid) {
      return ctx.reply(`⚠️ ${amountVal.error}`);
    }

    // Validate asset
    const assetVal = parseAsset(assetRaw);
    if (!assetVal.valid) {
      return ctx.reply(`⚠️ ${assetVal.error}`);
    }

    try {
      // 1. Resolve Tag
      const resolved = await resolveFn(tag, config);

      // 2. Build SEP-0007 URI
      const sep7Uri = buildSep7PayUri({
        destination: resolved.accountId,
        amount: amountVal.normalized,
        asset: assetRaw,
        memo: resolved.memo,
        memoType: resolved.memoType,
        network: config.network,
      });

      // 3. Generate QR code
      const qrBuffer = await qrFn(sep7Uri);

      const displayAsset = assetVal.assetCode || 'XLM';
      let caption = `💳 *Payment Request for* \`${tag}\`\n\n`;
      caption += `• *Amount:* \`${amountVal.normalized} ${displayAsset}\`\n`;
      caption += `• *Recipient:* \`${shortenAddress(resolved.stellarAddress)}\`\n`;
      if (resolved.memo) {
        caption += `• *Memo (${resolved.memoType || 'text'}):* \`${resolved.memo}\`\n`;
      }
      caption += `• *Network:* \`${config.network}\`\n\n`;
      caption += `🔗 *SEP-07 Payment Link:*\n[Open in Stellar Wallet](${sep7Uri})\n\n`;
      caption += `Scan the QR code with any SEP-7 compatible Stellar wallet (e.g. LOBSTR, Freighter, Albedo).`;

      await ctx.replyWithPhoto(new InputFile(qrBuffer, 'sep7-payment-qr.png'), {
        caption,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      if (err.code === 'TAG_NOT_FOUND') {
        return ctx.reply(`❌ Tag \`${tag}\` was not found. Cannot generate payment link.`, {
          parse_mode: 'Markdown',
        });
      }
      if (err.code === 'TAG_BLOCKED') {
        return ctx.reply(`🚫 Tag \`${tag}\` is blocked. Payments to this tag are not permitted.`, {
          parse_mode: 'Markdown',
        });
      }
      if (err.code === 'SERVICE_UNAVAILABLE') {
        return ctx.reply(`🔌 Federation API is currently unavailable. Please try again later.`, {
          parse_mode: 'Markdown',
        });
      }
      return ctx.reply(`⚠️ Failed to generate payment link: ${err.message || 'Unknown error'}`);
    }
  });

  return bot;
}

module.exports = {
  createBot,
  HELP_MESSAGE,
};

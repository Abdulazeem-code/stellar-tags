# Stellar Tags Discord Bot

A standalone Discord bot built with Node.js 22 and [discord.js v14](https://discord.js.org/) for resolving Stellar Tags and sharing [SEP-0007](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md) payment links and QR codes via native Discord slash commands.

## Features

- **/resolve `tag:<tag>` `[public:<true|false>]`**: Queries the Stellar Tags federation API (`GET /federation?q=<tag>*<domain>&type=name`) and replies with an embed containing the shortened address, full public key, and attached memo.
- **/pay `tag:<tag>` `amount:<n>` `[asset:<asset>]` `[public:<true|false>]`**: Resolves the tag and returns an embed with a clickable `web+stellar:pay?...` link and an attached QR code image.
- **/help `[public:<true|false>]`**: Interactive documentation and command guide.
- **Ephemeral By Default**: All bot replies are private (`ephemeral: true`) by default to protect user privacy. Users can optionally pass `public: true` to share results with the channel.
- **Zero Key Custody**: The bot never handles, requests, or stores private keys or seeds. Payments are signed client-side by users in their own wallets (Freighter, LOBSTR, Albedo).
- **Validation & Error Handling**: Strict validation of amounts (positive, up to 7 decimal places), asset codes (alphanumeric 1-12 chars), and friendly embeds for missing or blocked tags and network/API errors.

---

## Prerequisites

- Node.js 22 or later (or Node 20+)
- A Discord Bot Application from the [Discord Developer Portal](https://discord.com/developers/applications)

---

## 1. Creating the Discord Application & Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it (e.g. `Stellar Tags Bot`).
2. Navigate to **Bot** in the left sidebar:
   - Click **Reset Token** to copy your `DISCORD_TOKEN`.
   - **Privileged Gateway Intents**: None needed! The bot only requires the default `Guilds` intent (`GatewayIntentBits.Guilds`) since it operates purely through slash commands.
3. Navigate to **OAuth2** -> **General**:
   - Copy the **Application ID** (`DISCORD_CLIENT_ID`).
4. Navigate to **OAuth2** -> **URL Generator**:
   - **Scopes**: Check `bot` and `applications.commands`.
   - **Bot Permissions**: Check:
     - `Send Messages`
     - `Embed Links`
     - `Attach Files`
     - `Use External Emojis`
   - Copy the generated URL and open it in your browser to invite the bot to your Discord server/guild.

---

## 2. Configuration

Create a `.env` file in `bots/discord/` by copying `.env.example`:

```bash
cp .env.example .env
```

Configure your variables:

```env
# Discord Bot Token
DISCORD_TOKEN=your_bot_token_here

# Discord Application / Client ID
DISCORD_CLIENT_ID=your_client_id_here

# Optional: Guild ID for instant development slash command deployment
# DISCORD_GUILD_ID=123456789012345678

# Stellar Tags Federation Base API URL
STELLAR_TAGS_API_BASE=https://api.stellar-tags.org

# Default domain for Stellar Tags federation lookup
STELLAR_TAGS_DOMAIN=stellar-tags.org

# Stellar Network: testnet or public (default: testnet)
NETWORK=testnet
```

---

## 3. Registering Slash Commands

Discord requires registering slash commands with its REST API before they appear in the UI:

```bash
cd bots/discord
npm run deploy-commands
```

> **Tip:** If `DISCORD_GUILD_ID` is set in `.env`, commands deploy instantly to that guild for fast testing. Without `DISCORD_GUILD_ID`, commands are registered globally across all servers.

---

## 4. Running Locally

### Install Dependencies

```bash
cd bots/discord
npm install
```

### Run Unit Tests

Unit tests mock the federation API and test tag resolution, SEP-7 URI construction, input validation, and Discord slash command execution:

```bash
npm test
```

### Start the Bot

```bash
npm start
```

---

## 5. Running with Docker

### Build Docker Image

```bash
cd bots/discord
docker build -t stellar-tags-discord-bot .
```

### Run Container

```bash
docker run -d \
  --name stellar-discord-bot \
  --env-file .env \
  --restart unless-stopped \
  stellar-tags-discord-bot
```

To view logs:

```bash
docker logs -f stellar-discord-bot
```

---

## 6. Usage Examples in Discord

### Resolving a Tag
```
/resolve tag:alice
/resolve tag:alice*stellar-tags.org public:true
```
Embed Output:
- **Title**: `Resolved Stellar Tag: alice`
- **Short Address**: `GDQ4X7...6U6C7G`
- **Memo**: `PlatformPayment (text)`
- **Full Stellar Account ID**: `GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G`

### Generating a Payment Link
```
/pay tag:alice amount:10
/pay tag:alice amount:5.5 asset:USDC public:true
/pay tag:alice amount:100 asset:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
```
Embed Output:
- **Clickable Wallet Link**: `[Open in Stellar Wallet](web+stellar:pay?...)`
- **Image**: High-resolution QR code image attachment for scanning with mobile wallets (Freighter, LOBSTR, Albedo).
- **Amount & Asset**: Formatted amount and asset code.
- **Recipient**: Shortened destination address.
- **Memo**: Pre-filled federation memo if configured on the tag.

# Stellar Tags Telegram Bot

A standalone Telegram bot built with Node.js 22 and [grammY](https://grammy.dev/) for resolving Stellar Tags and generating [SEP-0007](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md) payment links and QR codes directly inside Telegram.

## Features

- **/resolve `<tag>`**: Queries the Stellar Tags federation endpoint (`GET /federation?q=<tag>*<domain>&type=name`) and replies with the shortened address, full account ID, and memo.
- **/pay `<tag>` `<amount>` `[asset]`**: Resolves the recipient tag and returns a standard SEP-0007 (`web+stellar:pay?...`) link along with an interactive QR code image.
- **/help** and **/start**: Displays usage instructions, examples, and command references.
- **Client-Side Signing & Zero Custody**: The bot never holds secret keys or signs transactions. Users sign transactions securely in their own Stellar wallet (Freighter, LOBSTR, Albedo, etc.).
- **Input Validation & Friendly Errors**: Thorough validation of amounts (positive, max 7 decimals), asset codes (alphanumeric 1-12 chars), issuer addresses, and friendly error messages for unknown or blocked tags and network/API failures.

---

## Prerequisites

- Node.js 22 or later (or Node 20+)
- npm
- A Telegram Bot Token from [@BotFather](https://t.me/botfather)

---

## 1. Creating a Bot with BotFather

1. Open Telegram and search for [@BotFather](https://t.me/botfather).
2. Start a chat and send `/newbot`.
3. Follow the prompts to name your bot and choose a username (must end in `bot`, e.g. `stellar_tags_demo_bot`).
4. Copy the HTTP API token provided by BotFather (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`).

---

## 2. Configuration

Create a `.env` file in `bots/telegram/` by copying the example:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Telegram Bot Token from @BotFather
TELEGRAM_BOT_TOKEN=your_bot_token_here

# Stellar Tags Federation Base API URL
STELLAR_TAGS_API_BASE=https://api.stellar-tags.org

# Default domain for Stellar Tags federation lookup (e.g. tag*stellar-tags.org)
STELLAR_TAGS_DOMAIN=stellar-tags.org

# Stellar Network: testnet or public (default: testnet)
NETWORK=testnet
```

---

## 3. Running Locally

### Install Dependencies

```bash
cd bots/telegram
npm install
```

### Run Tests

Unit tests mock the federation API and test tag resolution, SEP-7 URI construction (including custom issued assets), input validation, and bot commands:

```bash
npm test
```

### Start the Bot

```bash
npm start
```

---

## 4. Running with Docker

### Build Docker Image

```bash
cd bots/telegram
docker build -t stellar-tags-telegram-bot .
```

### Run Container

```bash
docker run -d \
  --name stellar-telegram-bot \
  --env-file .env \
  --restart unless-stopped \
  stellar-tags-telegram-bot
```

To view logs:

```bash
docker logs -f stellar-telegram-bot
```

---

## 5. Usage & Examples in Telegram

### Resolving a Tag
```
/resolve alice
```
Reply:
```
Resolved Stellar Tag: alice

• Address: GDQ4X7...6U6C7G
• Full Account ID:
GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G
• Memo (text): PlatformPayment
```

### Requesting Payment
```
/pay alice 10
/pay alice 5.5 USDC
/pay alice 25 USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
```
The bot generates:
- A QR code image containing the encoded SEP-0007 URI.
- A clickable `[Open in Stellar Wallet]` link that opens any SEP-0007 compliant wallet.

---

## Security

- **Zero Secret Keys**: The service does not store, request, or handle private keys, seeds, or signers.
- **Sanitized Inputs**: All tag names, amounts, and asset parameters are validated and URI-encoded before generating payment URIs.

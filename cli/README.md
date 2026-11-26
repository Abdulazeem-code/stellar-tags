# stellar-tags CLI

A command-line tool for developers, power users, and CI/CD automation to resolve Stellar Tags, look up registered addresses, build [SEP-0007](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md) payment links (with terminal QR codes), and submit Stellar payments safely.

## Features

- **`stellar-tags resolve <tag>`**: Resolves a Stellar tag to its destination address and memo via public federation (`GET /federation?type=name`).
- **`stellar-tags lookup <G...address>`**: Reverse-lookups registered tags and balances for a Stellar account address (`GET /lookup?address=`).
- **`stellar-tags link <tag>`**: Constructs standard SEP-0007 `web+stellar:pay?...` URIs, with an optional `--qr` flag to render an ASCII QR code directly in the terminal.
- **`stellar-tags pay <tag>`**: Builds and submits transactions to Horizon. **Security Guarantee:** Secret keys are *never* accepted as command-line arguments and *never* logged; keys are read exclusively from a designated environment variable via `--secret-env <VAR>`.
- **Safety Gate**: Testnet by default; sending payments to the public network (`--network public`) requires an explicit `--yes` confirmation flag.
- **Machine-Readable**: Global `--json` option outputs structured JSON across all commands for scripting and piping.
- **Clean Exit Codes**:
  - `0`: Success
  - `1`: User/validation error (invalid arguments, amount format, tag not found, missing confirmation)
  - `2`: Network/API error (Stellar Tags API down, Horizon RPC failure)

---

## Installation & Running

### Option 1: Run via npx / local folder

From the `cli/` directory:

```bash
cd cli
npm install
npm test
```

Run directly with `npx .`:

```bash
npx . --help
npx . resolve alice
```

Or with `node`:

```bash
node ./bin/stellar-tags.js --help
```

### Option 2: Link globally with npm

```bash
cd cli
npm link
stellar-tags --help
```

---

## Configuration

The CLI supports environment variables (loaded automatically from a `.env` file if present):

| Environment Variable | CLI Option | Default | Description |
|---|---|---|---|
| `STELLAR_TAGS_API_BASE` | `--api <url>` | `http://localhost:3000` | Base URL of Stellar Tags API |
| `STELLAR_TAGS_DOMAIN` | `--domain <domain>` | `stellar-tags.org` | Default federation domain suffix |
| `NETWORK` | `--network <network>` | `testnet` | Stellar network (`testnet` or `public`) |

---

## Command Reference & Examples

### 1. Resolve a Tag
Resolves a tag using public federation:

```bash
stellar-tags resolve alice
stellar-tags resolve alice*stellar-tags.org
```

**JSON Output:**
```bash
stellar-tags resolve alice --json
```
```json
{
  "tag": "alice",
  "federationQuery": "alice*stellar-tags.org",
  "accountId": "GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G",
  "stellarAddress": "GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G",
  "memo": "PlatformPayment",
  "memoType": "text"
}
```

---

### 2. Lookup an Address
Performs a reverse lookup to find the tag registered to a Stellar public address:

```bash
stellar-tags lookup GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G
stellar-tags lookup GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G --json
```

---

### 3. Generate a SEP-0007 Payment Link & QR Code
Generates a payment URI for client wallets:

```bash
stellar-tags link alice --amount 10
stellar-tags link alice --amount 25.5 --asset USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN --memo "Invoice-42"
```

**With Terminal QR Code:**
```bash
stellar-tags link alice --amount 10 --qr
```

---

### 4. Submit a Payment

Builds and signs a transaction securely, submitting it to the Stellar network.

> **Security Note:** You must pass the *name* of the environment variable containing your secret key via `--secret-env`. The CLI never accepts raw secret keys on the command line, preventing keys from leaking into shell history (`.bash_history`), process listings (`ps aux`), or CI logs.

```bash
# 1. Set your key in an environment variable
export MY_STELLAR_KEY="SC..."   # or $env:MY_STELLAR_KEY="SC..." in PowerShell

# 2. Execute payment on testnet
stellar-tags pay alice --amount 5.0 --secret-env MY_STELLAR_KEY
```

**Custom Assets & Memos:**
```bash
stellar-tags pay alice --amount 100 --asset USDC:GA5Z... --memo "Bounty #1073" --secret-env MY_STELLAR_KEY
```

**Public Network Submission (Requires `--yes` confirmation):**
```bash
stellar-tags pay alice --amount 10 --network public --yes --secret-env MY_STELLAR_KEY
```

---

## Exit Codes

| Code | Meaning | Example |
|---|---|---|
| `0` | Success | Command executed successfully |
| `1` | User Error | Invalid amount, missing `--yes` flag on public network, tag not found |
| `2` | Network / API Error | Stellar Tags server down, Horizon transaction rejected |

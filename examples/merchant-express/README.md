# Stellar Tags Express Merchant Shop

A minimal Node.js 22 shop showing tag resolution, SEP-0007 checkout, and verified webhook confirmation. It stores orders in a local JSON file and is intended as a single-process demo, not production order storage.

## Run locally

1. Install Node.js 22 and npm.
2. From this directory, install dependencies and create your local environment file:

   ```sh
   npm install
   node -e "require('node:fs').copyFileSync('.env.example', '.env')"
   ```

3. Set `MERCHANT_TAG` to a registered Stellar Tags username, `WEBHOOK_SECRET` to the secret you configure for its webhook, and `STELLAR_TAGS_API_BASE` to the public API origin (for a local API, `http://localhost:5000`). Keep the secret private.
4. Start the shop:

   ```sh
   npm start
   ```

5. Visit [http://localhost:3000](http://localhost:3000). Choose a product; checkout displays the tag, amount, unique order memo, wallet link, and QR code.

`NETWORK=testnet` is the demo default. Set `HORIZON_API` to the corresponding Horizon endpoint when using a different network. The shop resolves `MERCHANT_TAG` through the public `GET /federation?q=...` endpoint.

## Configure webhook delivery

1. Expose port 3000 with a tunnel such as `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.
2. In Stellar Tags, register the tunnel URL ending in `/webhooks/stellar-tags` as a webhook for `payment.received`. Copy its generated webhook secret to `WEBHOOK_SECRET` in `.env`, then restart the shop.
3. Use a testnet Stellar wallet to open the checkout's SEP-0007 link or scan its QR code and submit the payment. Include the displayed memo exactly.
4. The example verifies the timestamp-bound HMAC against the raw body before JSON parsing. It matches the payment memo and exact seven-decimal XLM amount; it fetches the transaction from Horizon for the memo when the webhook payload does not include one. A matching payment marks the order paid, and the checkout page polls the shop's own order endpoint until it displays `Paid`.

Invalid signatures receive HTTP 401. Unmatched payments are acknowledged but do not change an order. Horizon lookup failures receive an HTTP 500 so delivery can be retried. Repeated matching webhooks do not reapply the paid transition.

## Tests

The focused tests cover signature verification (valid, bad, expired), exact amount and memo matching, underpayment, and repeated delivery:

```sh
npm test
```

A real testnet payment and screenshot/recording require an operator-provided registered webhook, funded wallet, and reachable tunnel; no fabricated payment proof is included.

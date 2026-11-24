# Payment requests: testnet walkthrough

This walkthrough creates a payment request, pays it on the Stellar testnet,
and watches it flip to `paid` over Server-Sent Events and a webhook. It takes
about 10 minutes. Endpoint details are in
[api-reference.md](api-reference.md#payment-requests).

You need Docker, Node.js 20+, `curl`, and `jq`.

## 1. Start the stack

```bash
docker compose --profile dev up -d
docker compose exec backend npx prisma migrate deploy
docker compose exec backend npm run db:seed
```

The API is now on `http://localhost:5000`. The dev stack uses the testnet by
default (`HORIZON_NETWORK=testnet`).

Start the Horizon listener in a second terminal. It watches registered
accounts, matches payments to requests, and delivers webhooks:

```bash
docker compose exec backend npm run listener
```

Set a few shell variables used below:

```bash
API=http://localhost:5000/api/v1
```

## 2. Create two funded testnet accounts

One account receives the payment (the merchant), the other pays. Run this
from `stellar-payment-platform/` so `@stellar/stellar-sdk` resolves:

```bash
node -e '
const { Keypair } = require("@stellar/stellar-sdk");
for (const who of ["MERCHANT", "PAYER"]) {
  const kp = Keypair.random();
  console.log(`export ${who}_SECRET=${kp.secret()}`);
  console.log(`export ${who}_ADDRESS=${kp.publicKey()}`);
}' > /tmp/testnet-keys.sh
source /tmp/testnet-keys.sh

curl -s "https://friendbot.stellar.org?addr=$MERCHANT_ADDRESS" > /dev/null
curl -s "https://friendbot.stellar.org?addr=$PAYER_ADDRESS" > /dev/null
```

These are throwaway testnet keys. Never use a mainnet secret here.

## 3. Register the merchant tag

```bash
curl -s -X POST $API/register \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"walkthrough\",\"address\":\"$MERCHANT_ADDRESS\"}" | jq
```

The response shows the full tag, for example `walkthrough*localhost`. Save it:

```bash
TAG='walkthrough*localhost'
```

The listener picks up new accounts every `POLL_INTERVAL_MS` (60 seconds by
default). Wait for `Watching payments for <MERCHANT_ADDRESS>` in its log before paying.

## 4. Sign the ownership messages

Creating a request and registering a webhook both prove you own the tag by
signing `<operation>:<tag>` with the merchant key:

```bash
sign() {
  node -e '
const crypto = require("crypto");
const { Keypair } = require("@stellar/stellar-sdk");
const kp = Keypair.fromSecret(process.env.MERCHANT_SECRET);
const hash = crypto.createHash("sha256")
  .update(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(process.argv[1])]))
  .digest();
process.stdout.write(kp.sign(hash).toString("base64"));' "$1"
}

PR_SIGNATURE=$(sign "payment-request:$TAG")
WEBHOOK_SIGNATURE=$(sign "webhook:$TAG")
```

## 5. Register a webhook

Any public HTTPS endpoint that shows incoming requests works. For example,
open <https://webhook.site>, copy your unique URL, then:

```bash
WEBHOOK_URL='https://webhook.site/<your-id>'

curl -s -X POST $API/webhooks \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$TAG\",\"url\":\"$WEBHOOK_URL\",\"signature\":\"$WEBHOOK_SIGNATURE\",\"signerAddress\":\"$MERCHANT_ADDRESS\"}" | jq
```

Keep the returned `secret`: it verifies the webhook signature (see
[webhook-signature-verification.md](webhook-signature-verification.md)).

## 6. Create the payment request

```bash
curl -s -X POST $API/payment-requests \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: walkthrough-$(date +%s)" \
  -H "X-Stellar-Signature: $PR_SIGNATURE" \
  -H "X-Stellar-Signer: $MERCHANT_ADDRESS" \
  -d "{\"tag\":\"$TAG\",\"amount\":\"5\",\"asset\":\"XLM\",\"description\":\"Walkthrough invoice\"}" \
  | tee /tmp/payment-request.json | jq

REQUEST_ID=$(jq -r .data.id /tmp/payment-request.json)
MEMO=$(jq -r .data.memo /tmp/payment-request.json)
```

The response includes:

- `data.status`: `pending`
- `data.memo`: the memo the payer must use (generated, because none was sent)
- `link`: the HTTPS pay link to share
- `sep7`: a `web+stellar:pay` URI that wallets understand

## 7. Open the link and the QR code

```bash
jq -r .link /tmp/payment-request.json
curl -s -o /tmp/payment-request.png "$API/payment-requests/$REQUEST_ID/qr.png?format=sep7"
```

Open the PNG and scan it with a testnet wallet, or use the payment script
below.

## 8. Watch the request

In a third terminal, open the event stream:

```bash
curl -N $API/payment-requests/$REQUEST_ID/events
```

You get a `connected` event and a `snapshot` with `"status":"pending"`.

## 9. Pay on testnet

```bash
export MERCHANT_ADDRESS PAYER_SECRET MEMO
node -e '
const { Keypair, Horizon, TransactionBuilder, Operation, Asset, Memo, Networks, BASE_FEE } =
  require("@stellar/stellar-sdk");
(async () => {
  const server = new Horizon.Server("https://horizon-testnet.stellar.org");
  const payer = Keypair.fromSecret(process.env.PAYER_SECRET);
  const account = await server.loadAccount(payer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({
      destination: process.env.MERCHANT_ADDRESS,
      asset: Asset.native(),
      amount: "5",
    }))
    .addMemo(Memo.text(process.env.MEMO))
    .setTimeout(60)
    .build();
  tx.sign(payer);
  const res = await server.submitTransaction(tx);
  console.log("paid:", res.hash);
})().catch((e) => { console.error(e.response?.data || e); process.exit(1); });'
```

The memo, the asset and at least the requested amount must match, or the
payment is ignored.

## 10. See it flip to paid

Within a few seconds of the transaction closing:

- The event stream prints a `payment-update` with `"status":"paid"`,
  `"type":"payment_request"` and the transaction hash.
- Your webhook endpoint receives a `payment_request.paid` delivery (and a
  `payment.received` one) signed with `X-Webhook-Signature`.
- `GET $API/payment-requests/$REQUEST_ID` shows `status: "paid"`, `paidAt`
  and `transactionHash`.
- The QR endpoint now answers with `Cache-Control: no-store`.

## Other outcomes

- **Cancel:** sign `payment-request:<tag>` as above, then
  `POST $API/payment-requests/$REQUEST_ID/cancel`. The stream shows
  `cancelled` and the webhook receives `payment_request.cancelled`.
- **Expire:** create a request with `"expiresAt"` a minute or two ahead and
  do not pay it. Within a minute of that time, the stream shows `expired` and
  the webhook receives `payment_request.expired`.

## Troubleshooting

- **Nothing happens after paying:** check the listener log. The merchant
  account must be watched (step 3), and the memo must match exactly.
- **No webhook:** the listener process also runs the webhook worker, so it
  must be running. Failed deliveries are retried and then parked on the dead
  letter queue (`GET /admin/dlq`).
- **`401` on create or cancel:** the signature must be over
  `payment-request:<full tag>` in lower case, signed by the tag's address.

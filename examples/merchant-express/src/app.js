import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import { JsonOrderStore } from "./order-store.js";
import { verifyWebhook } from "./webhook-verification.js";

const PRODUCTS = [
  { id: "mug", name: "Stellar Tags mug", amount: "12.50" },
  { id: "shirt", name: "Stellar Tags shirt", amount: "25.00" },
];
const NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  public: "Public Global Stellar Network ; September 2015",
};
const ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;
const DEFAULT_STORE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../data/orders.json",
);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function requireConfig(env) {
  for (const key of ["MERCHANT_TAG", "WEBHOOK_SECRET", "STELLAR_TAGS_API_BASE"]) {
    if (!env[key]) throw new Error(`${key} is required`);
  }
  const network = (env.NETWORK || "testnet").toLowerCase();
  if (!NETWORK_PASSPHRASES[network]) {
    throw new Error("NETWORK must be testnet or public");
  }
  return { network, networkPassphrase: NETWORK_PASSPHRASES[network] };
}

async function resolveMerchantAddress(apiBase, merchantTag, fetchImpl) {
  const endpoint = new URL("/federation", apiBase);
  endpoint.searchParams.set("q", merchantTag);
  const response = await fetchImpl(endpoint);
  if (!response.ok) {
    throw new Error(`Tag lookup failed with HTTP ${response.status}`);
  }
  const result = await response.json();
  if (typeof result.account_id !== "string" || !ADDRESS_PATTERN.test(result.account_id)) {
    throw new Error("Tag lookup did not return a valid Stellar account address");
  }
  return result.account_id;
}

function makePaymentLink({ destination, amount, memo, network, networkPassphrase }) {
  const params = new URLSearchParams({
    destination,
    amount,
    memo,
    memo_type: "MEMO_TEXT",
    network,
    network_passphrase: networkPassphrase,
  });
  return `web+stellar:pay?${params.toString()}`;
}

function renderProductPage(merchantTag) {
  const cards = PRODUCTS.map((product) => `
    <article class="product">
      <h2>${escapeHtml(product.name)}</h2>
      <p>${escapeHtml(product.amount)} XLM</p>
      <form method="post" action="/checkout">
        <input type="hidden" name="product" value="${escapeHtml(product.id)}">
        <button type="submit">Pay with Stellar Tags</button>
      </form>
    </article>`).join("");
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Stellar Tags Shop</title>
<style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem;color:#17233b}
.products{display:flex;gap:1rem;flex-wrap:wrap}.product{border:1px solid #ccd3df;border-radius:12px;padding:1.25rem;min-width:220px}
button{background:#5336cc;color:white;border:0;border-radius:6px;padding:.7rem 1rem;cursor:pointer}</style>
<h1>Stellar Tags Shop</h1><p>Pay the merchant <strong>${escapeHtml(merchantTag)}</strong>.</p>
<main class="products">${cards}</main></html>`;
}

function renderCheckoutPage(order, qrDataUrl, paymentLink) {
  const orderId = escapeHtml(order.id);
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Checkout ${orderId}</title>
<style>body{font:16px system-ui;max-width:640px;margin:3rem auto;padding:0 1rem;color:#17233b}
img{width:240px;height:240px}.status{font-weight:700}</style>
<h1>Checkout</h1><p>Merchant: <strong>${escapeHtml(order.merchantTag)}</strong></p>
<p>Amount: <strong>${escapeHtml(order.amount)} XLM</strong></p>
<p>Order memo: <code>${escapeHtml(order.memo)}</code></p>
<p><a href="${escapeHtml(paymentLink)}">Open in a Stellar wallet</a></p>
<img src="${escapeHtml(qrDataUrl)}" alt="QR code for the Stellar payment link">
<p class="status" id="status">Waiting for payment...</p>
<script>
const status = document.getElementById("status");
async function refreshOrder() {
  const response = await fetch("/orders/${orderId}");
  if (!response.ok) return;
  const order = await response.json();
  if (order.status === "paid") {
    status.textContent = "Paid";
    return;
  }
  window.setTimeout(refreshOrder, 3000);
}
window.setTimeout(refreshOrder, 1500);
</script></html>`;
}

async function transactionMemo(payload, horizonApi, fetchImpl) {
  const data = payload.data;
  const directMemo = data?.memo ?? data?.metadata?.memo ?? payload.memo;
  if (typeof directMemo === "string") return directMemo;
  const transactionHash = data?.transaction_hash;
  if (typeof transactionHash !== "string" || !transactionHash) return null;

  const endpoint = new URL(
    `/transactions/${encodeURIComponent(transactionHash)}`,
    horizonApi,
  );
  const response = await fetchImpl(endpoint);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Horizon lookup failed with HTTP ${response.status}`);
  }
  const transaction = await response.json();
  return typeof transaction.memo === "string" ? transaction.memo : null;
}

export function createApp({
  env = process.env,
  orderStore = new JsonOrderStore(DEFAULT_STORE_PATH),
  fetchImpl = fetch,
} = {}) {
  const { network, networkPassphrase } = requireConfig(env);
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_request, response) => {
    response.type("html").send(renderProductPage(env.MERCHANT_TAG));
  });

  app.post("/checkout", async (request, response, next) => {
    try {
      const product = PRODUCTS.find((item) => item.id === request.body.product);
      if (!product) {
        response.status(400).send("Unknown product");
        return;
      }
      const destination = await resolveMerchantAddress(
        env.STELLAR_TAGS_API_BASE,
        env.MERCHANT_TAG,
        fetchImpl,
      );
      const id = randomUUID();
      const memo = `st-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const order = orderStore.create({
        id,
        product: product.name,
        amount: product.amount,
        memo,
        merchantTag: env.MERCHANT_TAG,
        destination,
        network,
        status: "pending",
        createdAt: new Date().toISOString(),
      });
      response.redirect(303, `/checkout/${encodeURIComponent(order.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.get("/checkout/:id", async (request, response, next) => {
    try {
      const order = orderStore.get(request.params.id);
      if (!order) {
        response.status(404).send("Order not found");
        return;
      }
      const paymentLink = makePaymentLink({
        destination: order.destination,
        amount: order.amount,
        memo: order.memo,
        network,
        networkPassphrase,
      });
      const qrDataUrl = await QRCode.toDataURL(paymentLink);
      response.type("html").send(renderCheckoutPage(order, qrDataUrl, paymentLink));
    } catch (error) {
      next(error);
    }
  });

  app.get("/orders/:id", (request, response) => {
    const order = orderStore.get(request.params.id);
    if (!order) {
      response.status(404).json({ error: "Order not found" });
      return;
    }
    response.json({
      id: order.id,
      status: order.status,
      amount: order.amount,
      memo: order.memo,
      paidAt: order.paidAt ?? null,
    });
  });

  app.post(
    "/webhooks/stellar-tags",
    express.raw({ type: "application/json" }),
    async (request, response, next) => {
      const verification = verifyWebhook(
        request.body,
        request.headers,
        env.WEBHOOK_SECRET,
      );
      if (!verification.valid) {
        response.status(401).json({ error: verification.reason });
        return;
      }
      if (verification.payload.event !== "payment.received") {
        response.sendStatus(200);
        return;
      }
      try {
        const memo = await transactionMemo(
          verification.payload,
          env.HORIZON_API || "https://horizon-testnet.stellar.org",
          fetchImpl,
        );
        if (memo === null) {
          response.json({ received: true, matched: false });
          return;
        }
        const payment = orderStore.markPaidIfMatching({
          memo,
          amount: verification.payload.data?.amount,
          paymentId: verification.payload.data?.transaction_hash ?? verification.payload.event_id,
        });
        response.json({ received: true, ...payment });
      } catch (error) {
        next(error);
      }
    },
  );

  app.use((error, _request, response, _next) => {
    console.error("Merchant example request failed:", error);
    response.status(500).send("Request failed");
  });

  return app;
}

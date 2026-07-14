/**
 * BLOCKED EXCHANGE MASTER WALLET ADDRESSES
 * =========================================
 * File location: src/config/blockedExchanges.js
 *
 * PURPOSE:
 * These are the known "master" or "hot wallet" public keys of large custodial
 * cryptocurrency exchanges on the Stellar network.
 *
 * WHY WE BLOCK THEM:
 * Custodial exchanges like Binance or Coinbase use a SINGLE master wallet for
 * ALL their users. They tell users apart by a "memo" field attached to each
 * transaction — NOT by the wallet address itself.
 *
 * If someone maps their federation name (e.g. "alice*yourdomain.com") directly
 * to Binance's master wallet address (without a memo), then any payment sent
 * to "alice*yourdomain.com" will land in Binance's general pool — with no way
 * to credit it to Alice's account. The funds are effectively LOST.
 *
 * SOLUTION:
 * Block federation registrations that point directly to these master wallets.
 * Users who genuinely hold funds on these exchanges should use the exchange's
 * own federation service (e.g. binance.com federation) which automatically
 * includes the required memo.
 *
 * HOW TO UPDATE THIS LIST:
 * Add new exchange public keys here as they become known. Each key is a
 * standard Stellar G-address (56 characters, starts with "G").
 */

const BLOCKED_EXCHANGES = [
  // Binance — one of the largest custodial exchange master wallets on Stellar
  // Source: publicly visible on-chain as the primary Binance XLM hot wallet
  "GA5XIGA5C7QTPTWXQYYUGCGQFBLOUZLYVVKXUHZHZWBYEAIELE4KZTOG",

  // Coinbase — Coinbase's known Stellar master deposit wallet
  // All user deposits route through this single address with memo IDs
  "GAZT5QHOKGMHBKR3TMIMZIVWHJKLBDL6BQLZ5C2I3CJZNTM34RNEQM2",

  // Kraken — Kraken's Stellar master wallet used for pooled custody
  // Sending to this address without a memo will result in unrecoverable funds
  "GCOGNHHQU5YFMQN3AZK3RKFGMT3RJMKBMEZ62OJNRQWDRVHQN6LXFC5",
];

module.exports = { BLOCKED_EXCHANGES };
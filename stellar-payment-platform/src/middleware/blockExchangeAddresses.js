/**
 * CUSTODIAL EXCHANGE ADDRESS GUARD (Middleware)
 * ==============================================
 * File location: src/middleware/blockExchangeAddresses.js
 *
 * PURPOSE:
 * This is an Express middleware function. Think of middleware as a "checkpoint"
 * that runs BEFORE the main registration logic. If the check fails, it stops
 * the request here and returns an error — the registration code never runs.
 *
 * HOW MIDDLEWARE WORKS (simple analogy):
 *   Request → [this middleware checkpoint] → [registration controller]
 *                      ↓ if blocked
 *                   400 Error returned immediately
 *
 * This middleware is kept in its own file so it can be:
 *   1. Reused on any route that accepts a Stellar address
 *   2. Tested independently from the controller
 *   3. Updated without touching business logic
 */

const { BLOCKED_EXCHANGES } = require("../config/blockedExchanges");

/**
 * blockExchangeAddresses
 * ----------------------
 * Checks whether the incoming registration address belongs to a known
 * custodial exchange master wallet. If it does, the request is rejected
 * immediately with a 400 Bad Request response.
 *
 * @param {object} req  - The Express request object. We read req.body.address
 * @param {object} res  - The Express response object. Used to send errors back.
 * @param {function} next - Calls the next middleware/controller if check passes.
 */
function blockExchangeAddresses(req, res, next) {
  // Pull the Stellar public key the user wants to register.
  // It may come from the request body (POST) or query params (GET).
  const address = req.body?.address || req.query?.address;

  // If no address was provided at all, let the controller handle that
  // validation — it's not our job here. Move on to the next step.
  if (!address) {
    return next();
  }

  // Core check: is this address in our blocklist?
  // Array.includes() does a strict equality check — fast and reliable.
  if (BLOCKED_EXCHANGES.includes(address)) {
    // Log the attempt for audit/monitoring purposes
    console.warn(
      `[SECURITY] Blocked federation registration attempt to exchange wallet: ${address}`
    );

    // Return HTTP 400 Bad Request with a clear, user-facing error message.
    // We use 400 (not 403) because the request is malformed from a business
    // logic perspective — the user made an invalid choice, not an auth error.
    return res.status(400).json({
      error: "Cannot map federation addresses directly to custodial exchange master wallets.",
      detail:
        "The address you provided belongs to a known custodial exchange (e.g. Binance, Coinbase, Kraken). " +
        "Mapping your federation name to this address would cause any incoming payments to be lost " +
        "in the exchange's general pool wallet. " +
        "If you hold funds on an exchange, use that exchange's own federation service instead, " +
        "which correctly includes your required memo/tag.",
    });
  }

  // Address is not on the blocklist — allow the request to continue
  // to the registration controller.
  return next();
}

module.exports = { blockExchangeAddresses };
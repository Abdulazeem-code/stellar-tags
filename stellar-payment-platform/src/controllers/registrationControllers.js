/**
 * FEDERATION REGISTRATION CONTROLLER
 * =====================================
 * File location: src/controllers/registrationController.js
 *
 * PURPOSE:
 * This controller handles the creation of new federation name mappings.
 * A "federation mapping" links a human-readable name like "alice*yourdomain.com"
 * to a Stellar wallet public key like "GABC...XYZ".
 *
 * SECURITY FEATURE ADDED (Issue: Block Federation Mapping to Exchange Wallets):
 * We now guard against users accidentally (or intentionally) mapping their
 * federation name to a custodial exchange's MASTER wallet without a memo.
 *
 * The check is done in TWO layers for defense-in-depth:
 *   Layer 1 → The middleware (blockExchangeAddresses.js) runs first on the route.
 *   Layer 2 → This controller also runs the check directly (shown below).
 *             This makes the controller safe even if used without the middleware.
 */

const { BLOCKED_EXCHANGES } = require("../config/blockedExchanges");
// If your project uses a database model, import it here, e.g.:
// const FederationRecord = require("../models/FederationRecord");

/**
 * registerFederationAddress
 * --------------------------
 * Registers a new federation name → Stellar address mapping.
 *
 * Expected request body:
 * {
 *   "federationName": "alice",        // the username part before the *
 *   "domain": "yourdomain.com",       // the domain part after the *
 *   "address": "GABC...XYZ",          // the Stellar G-address to map to
 *   "memoType": "text" | "id",        // optional memo type
 *   "memo": "12345"                   // optional memo value
 * }
 */
async function registerFederationAddress(req, res) {
  try {
    const { federationName, domain, address, memoType, memo } = req.body;

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Basic input validation
    // ─────────────────────────────────────────────────────────────────────────
    if (!federationName || !domain || !address) {
      return res.status(400).json({
        error: "Missing required fields: federationName, domain, and address are all required.",
      });
    }

    // Validate that the address looks like a valid Stellar public key.
    // Stellar public keys always start with 'G' and are 56 characters long.
    if (!address.startsWith("G") || address.length !== 56) {
      return res.status(400).json({
        error: "Invalid Stellar address format. Must be a 56-character G-address.",
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: 🔒 SECURITY CHECK — Block custodial exchange master wallets
    //
    // WHY THIS IS HERE (and not only in middleware):
    // The middleware version (blockExchangeAddresses.js) protects the route.
    // This in-controller check acts as a second line of defense — useful when:
    //   - The controller is called directly in tests
    //   - The route is modified and middleware is accidentally removed
    //   - Another internal service calls this function directly
    //
    // This is the "defense-in-depth" principle: never rely on a single guard.
    // ─────────────────────────────────────────────────────────────────────────

    if (BLOCKED_EXCHANGES.includes(address)) {
      // Log for security auditing
      console.warn(
        `[SECURITY] Controller-level block: federation registration to exchange wallet rejected. ` +
        `Attempted: ${federationName}*${domain} → ${address}`
      );

      return res.status(400).json({
        error: "Cannot map federation addresses directly to custodial exchange master wallets.",
        detail:
          "The address you provided belongs to a known custodial exchange. " +
          "Payments sent to a federation address mapped to an exchange master wallet " +
          "will be lost because the exchange cannot determine which user the payment belongs to " +
          "without a memo/tag. Use your exchange's own federation service instead.",
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3: Save the federation record to the database
    // Replace the placeholder below with your actual DB call.
    // ─────────────────────────────────────────────────────────────────────────

    // Example using a hypothetical model:
    // const newRecord = await FederationRecord.create({
    //   stellarAddress: address,
    //   federationName: `${federationName}*${domain}`,
    //   memoType: memoType || null,
    //   memo: memo || null,
    // });

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 4: Return a success response
    // ─────────────────────────────────────────────────────────────────────────
    return res.status(201).json({
      message: "Federation address registered successfully.",
      federationAddress: `${federationName}*${domain}`,
      stellarAddress: address,
      ...(memoType && { memoType }),
      ...(memo && { memo }),
    });

  } catch (error) {
    // Catch unexpected server errors and log them
    console.error("[ERROR] registrationController:", error);
    return res.status(500).json({
      error: "An unexpected error occurred during registration. Please try again.",
    });
  }
}

module.exports = { registerFederationAddress };
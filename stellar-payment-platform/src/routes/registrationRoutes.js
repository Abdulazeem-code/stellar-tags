/**
 * FEDERATION REGISTRATION ROUTES
 * ================================
 * File location: src/routes/registrationRoutes.js
 *
 * PURPOSE:
 * This file wires together the URL path, the security middleware, and the
 * controller into a single Express router.
 *
 * HOW THE REQUEST FLOWS:
 *
 *   POST /api/federation/register
 *          ↓
 *   [blockExchangeAddresses middleware]   ← Security check runs FIRST
 *          ↓ (only if address is NOT blocked)
 *   [registerFederationAddress controller] ← Business logic runs SECOND
 *
 * ADDING THE MIDDLEWARE TO THE ROUTE:
 * Notice how `blockExchangeAddresses` is passed as the SECOND argument to
 * router.post(), BEFORE the controller. This is how Express middleware works —
 * each function runs in the order it is listed, left to right.
 */

const express = require("express");
const router = express.Router();

// Import the security middleware from the middleware folder
const { blockExchangeAddresses } = require("../middleware/blockExchangeAddresses");

// Import the controller that handles the actual registration
const { registerFederationAddress } = require("../controllers/registrationController");

/**
 * POST /api/federation/register
 *
 * Registers a new federation name → Stellar address mapping.
 *
 * Request body expected:
 * {
 *   "federationName": "alice",
 *   "domain": "yourdomain.com",
 *   "address": "GABC...XYZ",
 *   "memoType": "text",    (optional)
 *   "memo": "12345"        (optional)
 * }
 */
router.post(
  "/register",
  blockExchangeAddresses,    // ← Middleware runs first: blocks exchange wallets
  registerFederationAddress  // ← Controller runs second: saves valid registrations
);

module.exports = router;
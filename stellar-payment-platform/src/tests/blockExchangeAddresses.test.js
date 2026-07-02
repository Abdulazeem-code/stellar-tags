/**
 * TESTS: Block Exchange Address Feature
 * =======================================
 * File location: src/tests/blockExchangeAddresses.test.js
 *
 * PURPOSE:
 * These tests verify that the security feature works correctly:
 *   ✅ Blocked exchange addresses are rejected with a 400 error
 *   ✅ Normal (non-exchange) addresses are allowed through
 *   ✅ Requests with no address at all are passed to the next handler
 *
 * HOW TO RUN:
 *   npm test
 *   -- or --
 *   npx jest src/tests/blockExchangeAddresses.test.js
 *
 * These tests use Jest. If your project uses Mocha/Chai, the structure is
 * similar but use describe/it/expect from those libraries instead.
 */

const { blockExchangeAddresses } = require("../middleware/blockExchangeAddresses");
const { BLOCKED_EXCHANGES } = require("../config/blockedExchanges");

// ─── Helpers: mock Express req/res/next objects ───────────────────────────────

/**
 * Creates a mock Express request object.
 * @param {string|null} address - The Stellar address in the request body.
 */
function mockReq(address = null) {
  return {
    body: address ? { address } : {},
    query: {},
  };
}

/**
 * Creates a mock Express response object that captures status and JSON output.
 */
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res); // allows chaining: res.status(400).json(...)
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("blockExchangeAddresses middleware", () => {

  // ── Test 1: Blocked exchange addresses should be rejected ──────────────────
  describe("when the address is a known custodial exchange wallet", () => {

    // Run the same test for EVERY address in the blocklist
    BLOCKED_EXCHANGES.forEach((exchangeAddress) => {
      it(`should return 400 for blocked address: ${exchangeAddress.substring(0, 12)}...`, () => {
        const req = mockReq(exchangeAddress);
        const res = mockRes();
        const next = jest.fn(); // tracks whether next() was called

        blockExchangeAddresses(req, res, next);

        // Should NOT call next() — request must be stopped here
        expect(next).not.toHaveBeenCalled();

        // Should return HTTP 400 status
        expect(res.status).toHaveBeenCalledWith(400);

        // Should return the expected error message
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: "Cannot map federation addresses directly to custodial exchange master wallets.",
          })
        );
      });
    });
  });

  // ── Test 2: Normal addresses should be allowed through ─────────────────────
  describe("when the address is a normal (non-exchange) wallet", () => {

    it("should call next() and allow registration to proceed", () => {
      // This is a random, non-exchange Stellar address
      const normalAddress = "GBZXN7PIRZGNMHGA7JPZ7BRNOS2LGMB7XUOSRPHXTG76GZBFEPNBLTE";

      const req = mockReq(normalAddress);
      const res = mockRes();
      const next = jest.fn();

      blockExchangeAddresses(req, res, next);

      // Should call next() — request proceeds to the controller
      expect(next).toHaveBeenCalled();

      // Should NOT send any response from middleware
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ── Test 3: Missing address should not crash the middleware ─────────────────
  describe("when no address is provided", () => {

    it("should call next() and let the controller handle the missing field error", () => {
      const req = mockReq(null); // no address
      const res = mockRes();
      const next = jest.fn();

      blockExchangeAddresses(req, res, next);

      // Missing address is not our responsibility — pass it to the controller
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
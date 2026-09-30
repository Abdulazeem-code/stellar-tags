/**
 * WebAuthn/Passkeys Routes
 * RESTful API for passwordless authentication using WebAuthn
 */

const express = require("express");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { ApiError } = require("../../errors");
const { requireJson } = require("../../middleware/requireJson");
const { signToken } = require("../../utils/jwt");
const {
  generateRegistrationChallenge,
  verifyRegistration,
  generateAuthenticationChallenge,
  verifyAuthentication,
  listUserCredentials,
  revokeCredential,
  updateCredentialName,
} = require("../../services/webauthnService");

const router = express.Router();

/**
 * @swagger
 * /api/v1/webauthn/register/options:
 *   post:
 *     summary: Generate registration options (challenge) for new passkey
 *     tags: [WebAuthn]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - userName
 *             properties:
 *               userId:
 *                 type: string
 *                 description: User identifier (email or username)
 *               userName:
 *                 type: string
 *                 description: User's display name
 *               userDisplayName:
 *                 type: string
 *                 description: Optional display name
 *               authenticatorAttachment:
 *                 type: string
 *                 enum: [platform, cross-platform]
 *                 description: Type of authenticator
 *     responses:
 *       200:
 *         description: Registration options with challenge
 */
router.post(
  "/register/options",
  requireJson,
  asyncHandler(async (req, res) => {
    const { userId, userName, userDisplayName, authenticatorAttachment } = req.body;

    if (!userId || !userName) {
      throw new ApiError(400, "userId and userName are required");
    }

    const options = await generateRegistrationChallenge(userId, userName, {
      userDisplayName,
      authenticatorAttachment,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({
      success: true,
      options,
    });
  })
);

/**
 * @swagger
 * /api/v1/webauthn/register/verify:
 *   post:
 *     summary: Verify registration response and register new passkey
 *     tags: [WebAuthn]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - registrationResponse
 *             properties:
 *               userId:
 *                 type: string
 *               registrationResponse:
 *                 type: object
 *                 description: Response from navigator.credentials.create()
 *               friendlyName:
 *                 type: string
 *                 description: Optional friendly name for the credential
 *     responses:
 *       200:
 *         description: Registration verified and credential stored
 */
router.post(
  "/register/verify",
  requireJson,
  asyncHandler(async (req, res) => {
    const { userId, registrationResponse, friendlyName, deviceType } = req.body;

    if (!userId || !registrationResponse) {
      throw new ApiError(400, "userId and registrationResponse are required");
    }

    const result = await verifyRegistration(userId, registrationResponse, {
      friendlyName,
      deviceType,
    });

    res.json({
      success: true,
      message: "Passkey registered successfully",
      data: result,
    });
  })
);

/**
 * @swagger
 * /api/v1/webauthn/authenticate/options:
 *   post:
 *     summary: Generate authentication options (challenge) for login
 *     tags: [WebAuthn]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId:
 *                 type: string
 *                 description: Optional user identifier (for discoverable credentials, can be omitted)
 *     responses:
 *       200:
 *         description: Authentication options with challenge
 */
router.post(
  "/authenticate/options",
  requireJson,
  asyncHandler(async (req, res) => {
    const { userId } = req.body;

    const options = await generateAuthenticationChallenge(userId, {
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({
      success: true,
      options,
    });
  })
);

/**
 * @swagger
 * /api/v1/webauthn/authenticate/verify:
 *   post:
 *     summary: Verify authentication response and complete login
 *     tags: [WebAuthn]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - authenticationResponse
 *             properties:
 *               authenticationResponse:
 *                 type: object
 *                 description: Response from navigator.credentials.get()
 *     responses:
 *       200:
 *         description: Authentication verified with JWT token
 */
router.post(
  "/authenticate/verify",
  requireJson,
  asyncHandler(async (req, res) => {
    const { authenticationResponse } = req.body;

    if (!authenticationResponse) {
      throw new ApiError(400, "authenticationResponse is required");
    }

    const result = await verifyAuthentication(authenticationResponse);

    // Issue JWT token for authenticated user
    let token = null;
    try {
      token = signToken(
        {
          sub: result.userId,
          userId: result.userId,
          authMethod: "webauthn",
        },
        {
          expiresIn: process.env.ACCESS_TOKEN_TTL || "15m",
        }
      );
    } catch (error) {
      // JWT keys not configured
      throw new ApiError(500, "Failed to generate authentication token");
    }

    res.json({
      success: true,
      message: "Authentication successful",
      data: {
        userId: result.userId,
        credentialId: result.credentialId,
        deviceType: result.deviceType,
      },
      token,
    });
  })
);

/**
 * @swagger
 * /api/v1/webauthn/credentials:
 *   get:
 *     summary: List user's registered passkeys
 *     tags: [WebAuthn]
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of registered credentials
 */
router.get(
  "/credentials",
  asyncHandler(async (req, res) => {
    const { userId } = req.query;

    if (!userId) {
      throw new ApiError(400, "userId is required");
    }

    const credentials = await listUserCredentials(userId);

    res.json({
      success: true,
      data: credentials,
      count: credentials.length,
    });
  })
);

/**
 * @swagger
 * /api/v1/webauthn/credentials/{credentialId}:
 *   delete:
 *     summary: Revoke a passkey
 *     tags: [WebAuthn]
 *     parameters:
 *       - in: path
 *         name: credentialId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Credential revoked
 */
router.delete(
  "/credentials/:credentialId",
  requireJson,
  asyncHandler(async (req, res) => {
    const { credentialId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      throw new ApiError(400, "userId is required");
    }

    const result = await revokeCredential(userId, credentialId);

    res.json({
      success: true,
      message: "Passkey revoked successfully",
      data: result,
    });
  })
);

/**
 * @swagger
 * /api/v1/webauthn/credentials/{credentialId}/name:
 *   patch:
 *     summary: Update passkey friendly name
 *     tags: [WebAuthn]
 *     parameters:
 *       - in: path
 *         name: credentialId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - friendlyName
 *             properties:
 *               userId:
 *                 type: string
 *               friendlyName:
 *                 type: string
 *     responses:
 *       200:
 *         description: Credential name updated
 */
router.patch(
  "/credentials/:credentialId/name",
  requireJson,
  asyncHandler(async (req, res) => {
    const { credentialId } = req.params;
    const { userId, friendlyName } = req.body;

    if (!userId || !friendlyName) {
      throw new ApiError(400, "userId and friendlyName are required");
    }

    const result = await updateCredentialName(userId, credentialId, friendlyName);

    res.json({
      success: true,
      message: "Passkey name updated successfully",
      data: result,
    });
  })
);

module.exports = router;

/**
 * WebAuthn Service
 * Implements passwordless authentication using WebAuthn/FIDO2 standard
 * Supports platform authenticators (Touch ID, Face ID, Windows Hello) and security keys
 */

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const crypto = require("crypto");
const { prisma } = require("../../prismaClient");
const { logger } = require("../logger");

// Relying Party configuration
const RP_NAME = process.env.WEBAUTHN_RP_NAME || "Stellar Tags";
const RP_ID = process.env.WEBAUTHN_RP_ID || "localhost";
const ORIGIN = process.env.WEBAUTHN_ORIGIN || "http://localhost:5001";
const CHALLENGE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Generate registration options (challenge) for a new credential
 * @param {string} userId - User identifier (email or username)
 * @param {string} userName - User's display name
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Registration options to send to client
 */
async function generateRegistrationChallenge(userId, userName, options = {}) {
  try {
    // Get existing credentials for this user to enable exclude list
    const existingCredentials = await prisma.webAuthnCredential.findMany({
      where: {
        userId,
        revokedAt: null,
      },
      select: {
        credentialId: true,
        transports: true,
      },
    });

    const excludeCredentials = existingCredentials.map((cred) => ({
      id: Buffer.from(cred.credentialId, "base64url"),
      type: "public-key",
      transports: cred.transports.length > 0 ? cred.transports : undefined,
    }));

    // Generate registration options
    const registrationOptions = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: userId,
      userName: userName,
      userDisplayName: options.userDisplayName || userName,
      timeout: options.timeout || 60000, // 60 seconds
      attestationType: options.attestationType || "none",
      excludeCredentials,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
        authenticatorAttachment: options.authenticatorAttachment, // 'platform' or 'cross-platform'
      },
      supportedAlgorithmIDs: [-7, -257], // ES256, RS256
    });

    // Store challenge in database
    await prisma.webAuthnChallenge.create({
      data: {
        challenge: registrationOptions.challenge,
        userId,
        type: "registration",
        expiresAt: new Date(Date.now() + CHALLENGE_TIMEOUT),
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
      },
    });

    logger.info({ userId, userName }, "Generated WebAuthn registration challenge");

    return registrationOptions;
  } catch (error) {
    logger.error({ error, userId }, "Failed to generate registration challenge");
    throw error;
  }
}

/**
 * Verify registration response and store credential
 * @param {string} userId - User identifier
 * @param {Object} registrationResponse - Response from authenticator
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Verification result with credential info
 */
async function verifyRegistration(userId, registrationResponse, options = {}) {
  try {
    const { challenge: expectedChallenge } = registrationResponse.response;

    // Retrieve and validate challenge
    const challengeRecord = await prisma.webAuthnChallenge.findFirst({
      where: {
        challenge: expectedChallenge,
        userId,
        type: "registration",
        used: false,
        expiresAt: {
          gt: new Date(),
        },
      },
    });

    if (!challengeRecord) {
      throw new Error("Invalid or expired challenge");
    }

    // Verify the registration response
    const verification = await verifyRegistrationResponse({
      response: registrationResponse,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Registration verification failed");
    }

    const { credentialPublicKey, credentialID, counter, aaguid, credentialBackedUp, credentialDeviceType } =
      verification.registrationInfo;

    // Store the credential
    const credential = await prisma.webAuthnCredential.create({
      data: {
        userId,
        credentialId: Buffer.from(credentialID).toString("base64url"),
        publicKey: Buffer.from(credentialPublicKey).toString("base64"),
        counter: BigInt(counter),
        deviceType: options.deviceType || "unknown",
        transports: registrationResponse.response.transports || [],
        aaguid: aaguid || null,
        credentialBackedUp: credentialBackedUp || false,
        credentialDeviceType: credentialDeviceType || null,
        friendlyName: options.friendlyName || null,
      },
    });

    // Mark challenge as used
    await prisma.webAuthnChallenge.update({
      where: { id: challengeRecord.id },
      data: {
        used: true,
        usedAt: new Date(),
      },
    });

    logger.info(
      { userId, credentialId: credential.credentialId },
      "WebAuthn credential registered successfully"
    );

    return {
      verified: true,
      credentialId: credential.credentialId,
      deviceType: credential.deviceType,
      friendlyName: credential.friendlyName,
    };
  } catch (error) {
    logger.error({ error, userId }, "Failed to verify registration");
    throw error;
  }
}

/**
 * Generate authentication options (challenge) for login
 * @param {string} userId - Optional user identifier (for resident keys, can be omitted)
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Authentication options to send to client
 */
async function generateAuthenticationChallenge(userId = null, options = {}) {
  try {
    let allowCredentials = [];

    // If userId is provided, get their credentials
    if (userId) {
      const userCredentials = await prisma.webAuthnCredential.findMany({
        where: {
          userId,
          revokedAt: null,
        },
        select: {
          credentialId: true,
          transports: true,
        },
      });

      allowCredentials = userCredentials.map((cred) => ({
        id: Buffer.from(cred.credentialId, "base64url"),
        type: "public-key",
        transports: cred.transports.length > 0 ? cred.transports : undefined,
      }));
    }

    // Generate authentication options
    const authenticationOptions = await generateAuthenticationOptions({
      rpID: RP_ID,
      timeout: options.timeout || 60000,
      allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
      userVerification: "preferred",
    });

    // Store challenge
    await prisma.webAuthnChallenge.create({
      data: {
        challenge: authenticationOptions.challenge,
        userId,
        type: "authentication",
        expiresAt: new Date(Date.now() + CHALLENGE_TIMEOUT),
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
      },
    });

    logger.info({ userId: userId || "any" }, "Generated WebAuthn authentication challenge");

    return authenticationOptions;
  } catch (error) {
    logger.error({ error, userId }, "Failed to generate authentication challenge");
    throw error;
  }
}

/**
 * Verify authentication response
 * @param {Object} authenticationResponse - Response from authenticator
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Verification result with user info
 */
async function verifyAuthentication(authenticationResponse, options = {}) {
  try {
    const { challenge: expectedChallenge, id: credentialIdRaw } = authenticationResponse;
    const credentialId = Buffer.from(credentialIdRaw, "base64url").toString("base64url");

    // Retrieve challenge
    const challengeRecord = await prisma.webAuthnChallenge.findFirst({
      where: {
        challenge: expectedChallenge,
        type: "authentication",
        used: false,
        expiresAt: {
          gt: new Date(),
        },
      },
    });

    if (!challengeRecord) {
      throw new Error("Invalid or expired challenge");
    }

    // Retrieve credential
    const credential = await prisma.webAuthnCredential.findUnique({
      where: {
        credentialId,
        revokedAt: null,
      },
    });

    if (!credential) {
      throw new Error("Credential not found or revoked");
    }

    // Verify the authentication response
    const verification = await verifyAuthenticationResponse({
      response: authenticationResponse,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: Buffer.from(credential.credentialId, "base64url"),
        credentialPublicKey: Buffer.from(credential.publicKey, "base64"),
        counter: Number(credential.counter),
        transports: credential.transports,
      },
      requireUserVerification: true,
    });

    if (!verification.verified) {
      throw new Error("Authentication verification failed");
    }

    const { newCounter } = verification.authenticationInfo;

    // Update credential counter and last used timestamp
    await prisma.webAuthnCredential.update({
      where: { id: credential.id },
      data: {
        counter: BigInt(newCounter),
        lastUsedAt: new Date(),
      },
    });

    // Mark challenge as used
    await prisma.webAuthnChallenge.update({
      where: { id: challengeRecord.id },
      data: {
        used: true,
        usedAt: new Date(),
      },
    });

    logger.info(
      { userId: credential.userId, credentialId: credential.credentialId },
      "WebAuthn authentication successful"
    );

    return {
      verified: true,
      userId: credential.userId,
      credentialId: credential.credentialId,
      deviceType: credential.deviceType,
    };
  } catch (error) {
    logger.error({ error }, "Failed to verify authentication");
    throw error;
  }
}

/**
 * List credentials for a user
 * @param {string} userId - User identifier
 * @returns {Promise<Array>} List of credentials
 */
async function listUserCredentials(userId) {
  const credentials = await prisma.webAuthnCredential.findMany({
    where: {
      userId,
      revokedAt: null,
    },
    select: {
      id: true,
      credentialId: true,
      deviceType: true,
      friendlyName: true,
      createdAt: true,
      lastUsedAt: true,
      transports: true,
      credentialBackedUp: true,
    },
    orderBy: {
      lastUsedAt: "desc",
    },
  });

  return credentials;
}

/**
 * Revoke a credential
 * @param {string} userId - User identifier
 * @param {string} credentialId - Credential ID to revoke
 * @returns {Promise<Object>} Revocation result
 */
async function revokeCredential(userId, credentialId) {
  const credential = await prisma.webAuthnCredential.findFirst({
    where: {
      userId,
      credentialId,
      revokedAt: null,
    },
  });

  if (!credential) {
    throw new Error("Credential not found");
  }

  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: {
      revokedAt: new Date(),
    },
  });

  logger.info({ userId, credentialId }, "WebAuthn credential revoked");

  return {
    revoked: true,
    credentialId,
  };
}

/**
 * Update credential friendly name
 * @param {string} userId - User identifier
 * @param {string} credentialId - Credential ID
 * @param {string} friendlyName - New friendly name
 * @returns {Promise<Object>} Update result
 */
async function updateCredentialName(userId, credentialId, friendlyName) {
  const credential = await prisma.webAuthnCredential.findFirst({
    where: {
      userId,
      credentialId,
      revokedAt: null,
    },
  });

  if (!credential) {
    throw new Error("Credential not found");
  }

  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: {
      friendlyName,
    },
  });

  logger.info({ userId, credentialId, friendlyName }, "WebAuthn credential name updated");

  return {
    updated: true,
    credentialId,
    friendlyName,
  };
}

/**
 * Cleanup expired challenges (run periodically)
 * @returns {Promise<number>} Number of deleted challenges
 */
async function cleanupExpiredChallenges() {
  const result = await prisma.webAuthnChallenge.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
    },
  });

  if (result.count > 0) {
    logger.info({ count: result.count }, "Cleaned up expired WebAuthn challenges");
  }

  return result.count;
}

module.exports = {
  generateRegistrationChallenge,
  verifyRegistration,
  generateAuthenticationChallenge,
  verifyAuthentication,
  listUserCredentials,
  revokeCredential,
  updateCredentialName,
  cleanupExpiredChallenges,
};

-- Create WebAuthn tables for passwordless authentication

-- WebAuthn Credentials: stores public keys and credential metadata
CREATE TABLE "webauthn_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "device_type" TEXT NOT NULL DEFAULT 'unknown',
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aaguid" TEXT,
    "credential_backed_up" BOOLEAN NOT NULL DEFAULT false,
    "credential_device_type" TEXT,
    "friendly_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- WebAuthn Challenges: stores temporary challenges for registration/authentication
CREATE TABLE "webauthn_challenges" (
    "id" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "user_id" TEXT,
    "type" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "used_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id")
);

-- Create indexes for webauthn_credentials
CREATE INDEX "webauthn_credentials_user_id_idx" ON "webauthn_credentials"("user_id");
CREATE INDEX "webauthn_credentials_credential_id_idx" ON "webauthn_credentials"("credential_id");
CREATE INDEX "webauthn_credentials_user_id_revoked_at_idx" ON "webauthn_credentials"("user_id", "revoked_at");
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_key" ON "webauthn_credentials"("credential_id");

-- Create indexes for webauthn_challenges
CREATE INDEX "webauthn_challenges_challenge_idx" ON "webauthn_challenges"("challenge");
CREATE INDEX "webauthn_challenges_expires_at_idx" ON "webauthn_challenges"("expires_at");
CREATE INDEX "webauthn_challenges_user_id_type_idx" ON "webauthn_challenges"("user_id", "type");
CREATE UNIQUE INDEX "webauthn_challenges_challenge_key" ON "webauthn_challenges"("challenge");

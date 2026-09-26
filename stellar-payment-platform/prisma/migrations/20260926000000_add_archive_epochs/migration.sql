-- #667 Data Archival Strategy
-- Tracks every archive epoch committed on-chain so the off-chain service
-- can reconstruct Merkle paths and verify inclusion proofs without hitting
-- the Soroban RPC for every request.

CREATE TABLE IF NOT EXISTS "archive_epochs" (
    "id"           TEXT     NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    "epoch"        BIGINT   NOT NULL UNIQUE,
    "merkle_root"  TEXT     NOT NULL,
    "record_count" INTEGER  NOT NULL DEFAULT 0,
    "description"  TEXT,
    "committed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast look-up by epoch number (used by the verification endpoint).
CREATE INDEX IF NOT EXISTS "archive_epochs_epoch_idx" ON "archive_epochs" ("epoch");

-- Stores the individual leaf records belonging to each epoch so that
-- Merkle inclusion proofs can be reconstructed entirely off-chain.
CREATE TABLE IF NOT EXISTS "archive_leaves" (
    "id"            TEXT    NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    "epoch_id"      TEXT    NOT NULL REFERENCES "archive_epochs" ("id") ON DELETE CASCADE,
    "record_type"   TEXT    NOT NULL,   -- 'UserVolume' | 'UserSpending' | 'RefundBalance'
    "primary_key"   TEXT    NOT NULL,   -- Stellar address (G... or C...)
    "secondary_key" TEXT,               -- token address for RefundBalance, NULL otherwise
    "leaf_hash"     TEXT    NOT NULL,   -- hex-encoded SHA-256 of the canonical leaf bytes
    -- Snapshot of the on-chain value at the time of archival.
    "value_json"    JSONB,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "archive_leaves_epoch_idx"   ON "archive_leaves" ("epoch_id");
CREATE INDEX IF NOT EXISTS "archive_leaves_primary_idx" ON "archive_leaves" ("primary_key");

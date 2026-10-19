-- #686 — `payments`, `routing_rules` and `wallet_balances` have been declared
-- in schema.prisma since the PostgreSQL migration, but no migration ever
-- created their tables. Two consequences, both invisible while the backend
-- tests ran against mock databases:
--
--   1. 20260926000000_add_fraud_detection ALTERs `payments`, so a database
--      bootstrapped from this directory aborts part-way through the chain and
--      `prisma migrate deploy` can never build a working schema.
--   2. Even where `payments` existed (environments provisioned out-of-band
--      with `prisma db push`), `routing_rules` and `wallet_balances` were
--      missing, so the rules engine and every balance read/write failed with
--      "relation does not exist".
--
-- The timestamp sorts immediately before 20260926000000_add_fraud_detection so
-- `payments` exists by the time that migration adds the fraud columns. The
-- fraud columns are deliberately NOT part of the CREATE TABLE below — that
-- migration owns them.
--
-- IF NOT EXISTS / the guarded foreign key keep environments that already have
-- these tables (db push) working, mirroring
-- 20260824120000_create_payment_intents.

-- CreateTable
CREATE TABLE IF NOT EXISTS "payments" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "from_address" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "asset_code" TEXT,
    "transaction_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "routing_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "client_org" TEXT,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "wallet_balances" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "asset_code" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payments_created_at_idx" ON "payments"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payments_from_address_idx" ON "payments"("from_address");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payments_to_address_idx" ON "payments"("to_address");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "routing_rules_active_priority_idx" ON "routing_rules"("active", "priority");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "routing_rules_client_org_idx" ON "routing_rules"("client_org");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_balances_username_idx" ON "wallet_balances"("username");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_balances_username_asset_code_key" ON "wallet_balances"("username", "asset_code");

-- AddForeignKey
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so guard on pg_constraint to
-- stay idempotent for databases that already carry the relationship.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallet_balances_username_fkey'
  ) THEN
    ALTER TABLE "wallet_balances"
      ADD CONSTRAINT "wallet_balances_username_fkey"
      FOREIGN KEY ("username") REFERENCES "username_registry"("username")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

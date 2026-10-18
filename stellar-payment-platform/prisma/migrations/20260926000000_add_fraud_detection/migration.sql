ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "risk_score" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "fraud_status" TEXT NOT NULL DEFAULT 'clear',
  ADD COLUMN IF NOT EXISTS "fraud_flagged_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "fraud_alerts" (
  "id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "transaction_hash" TEXT,
  "from_address" TEXT NOT NULL,
  "to_address" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "risk_score" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "reason" TEXT NOT NULL,
  "raw_event" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  CONSTRAINT "fraud_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "fraud_alerts_event_id_key" ON "fraud_alerts"("event_id");
CREATE INDEX IF NOT EXISTS "fraud_alerts_to_address_created_at_idx" ON "fraud_alerts"("to_address", "created_at");
CREATE INDEX IF NOT EXISTS "fraud_alerts_status_created_at_idx" ON "fraud_alerts"("status", "created_at");


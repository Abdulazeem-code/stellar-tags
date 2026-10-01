-- Asset-filtered routing analytics scan payments in created_at order.
CREATE INDEX IF NOT EXISTS "payments_asset_code_created_at_idx"
  ON "payments" ("asset_code", "created_at");

-- The (created_at, id) index also supports created_at-only range scans.
DROP INDEX IF EXISTS "payments_created_at_idx";

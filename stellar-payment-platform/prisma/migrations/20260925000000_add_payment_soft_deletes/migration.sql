-- Soft deletes for payment records (#731).
--
-- A payment is never hard-deleted from the application: the row is stamped
-- with deleted_at so the ledger stays auditable and the record can be brought
-- back through the admin restore endpoint. All payment read paths filter on
-- "deleted_at IS NULL"; the only permanent removal is the retention purge.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "payments_deleted_at_idx" ON "payments"("deleted_at");

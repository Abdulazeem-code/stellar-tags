-- #18: Add soft-delete support to username_registry
-- Adds a nullable deleted_at timestamp column. A NULL value means the record
-- is active; a non-null value means the account was unregistered and should
-- be excluded from all normal federation/lookup queries.

ALTER TABLE "username_registry" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Index to make soft-delete filters efficient (most rows will be NULL, so a
-- partial index on non-null values keeps the footprint small on Postgres).
CREATE INDEX "username_registry_deleted_at_idx" ON "username_registry"("deleted_at");

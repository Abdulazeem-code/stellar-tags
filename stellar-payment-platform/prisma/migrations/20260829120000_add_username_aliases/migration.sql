-- #613 — allow several federation usernames (aliases) per Stellar address.

-- The address can no longer be unique now that multiple usernames may point
-- at it. A plain index keeps reverse (type=id) lookups fast.
DROP INDEX "username_registry_address_key";
CREATE INDEX "username_registry_address_idx" ON "username_registry"("address");

-- `is_primary` marks the username that reverse federation lookups resolve to.
ALTER TABLE "username_registry" ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT false;

-- Every address currently has exactly one username; it becomes the primary.
UPDATE "username_registry" SET "is_primary" = true WHERE "deleted_at" IS NULL;

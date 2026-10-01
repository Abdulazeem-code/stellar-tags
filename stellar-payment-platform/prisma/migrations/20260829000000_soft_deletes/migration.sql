-- Add deleted_at column for soft deletes
-- IF NOT EXISTS: this duplicates 20260727120000_add_deleted_at, which made the
-- migration fail on any database that had already applied the earlier one
-- (and blocked every fresh deploy after it).
ALTER TABLE "username_registry" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
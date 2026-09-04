-- Add deleted_at column for soft deletes
ALTER TABLE "username_registry" ADD COLUMN "deleted_at" TIMESTAMP(3);
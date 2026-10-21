-- Align the archive tables with `prisma/schema.prisma`.
--
-- The original `add_archive_epochs` migration created the tables by hand, and
-- its definitions drifted from the datamodel in three ways:
--
--   * `id` carried a database-level `gen_random_uuid()::text` default, while
--     every other model in the schema declares `@default(uuid())`, which Prisma
--     satisfies on the client. The extra default is what `prisma migrate diff`
--     reports as drift.
--   * `created_at` / `committed_at` were created as `TIMESTAMPTZ`, while
--     Prisma maps `DateTime` to `TIMESTAMP(3)`.
--   * The indexes on `archive_leaves` were named `archive_leaves_epoch_idx` and
--     `archive_leaves_primary_idx`, while Prisma derives
--     `archive_leaves_epoch_id_idx` and `archive_leaves_primary_key_idx` from
--     the `@@index` declarations.
--
-- `prisma migrate diff --from-migrations … --to-schema-datamodel …` is now
-- empty, so the chain and the datamodel agree.

-- The foreign key is dropped and re-added so it ends up with the `ON UPDATE
-- CASCADE` clause Prisma expects.
ALTER TABLE "archive_leaves" DROP CONSTRAINT "archive_leaves_epoch_id_fkey";

ALTER TABLE "archive_epochs" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "committed_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

ALTER TABLE "archive_leaves" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

ALTER TABLE "archive_leaves" ADD CONSTRAINT "archive_leaves_epoch_id_fkey" FOREIGN KEY ("epoch_id") REFERENCES "archive_epochs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER INDEX "archive_leaves_epoch_idx" RENAME TO "archive_leaves_epoch_id_idx";

ALTER INDEX "archive_leaves_primary_idx" RENAME TO "archive_leaves_primary_key_idx";

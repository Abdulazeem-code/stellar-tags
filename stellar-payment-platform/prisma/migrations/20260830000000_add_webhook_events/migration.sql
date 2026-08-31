-- The `events` filter is declared on the Webhook model but was never migrated,
-- so a database built from these migrations rejects every webhook read and
-- write. The default preserves the documented all-events behaviour for rows
-- that predate the column.
ALTER TABLE "webhooks" ADD COLUMN "events" TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[];

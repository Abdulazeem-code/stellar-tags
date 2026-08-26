-- CreateTable: payment_intents backing the bulk registration endpoint.
-- Guards with IF NOT EXISTS because environments migrated before this file
-- may already have the table created out-of-band (e.g. via `prisma db push`);
-- those deployments skip this statement and stay consistent with the schema.
CREATE TABLE IF NOT EXISTS "payment_intents" (
    "id" TEXT NOT NULL,
    "external_id" TEXT,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "asset" TEXT,
    "memo_type" TEXT,
    "memo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_intents_to_idx" ON "payment_intents"("to");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_intents_from_idx" ON "payment_intents"("from");

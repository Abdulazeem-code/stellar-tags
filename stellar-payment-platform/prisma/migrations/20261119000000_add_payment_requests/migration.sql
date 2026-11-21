CREATE TABLE "payment_requests" (
    "id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'XLM',
    "memo_type" TEXT NOT NULL DEFAULT 'text',
    "memo" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "transaction_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_requests_memo_key" ON "payment_requests"("memo");
CREATE INDEX "payment_requests_destination_status_idx" ON "payment_requests"("destination", "status");
CREATE INDEX "payment_requests_status_expires_at_idx" ON "payment_requests"("status", "expires_at");

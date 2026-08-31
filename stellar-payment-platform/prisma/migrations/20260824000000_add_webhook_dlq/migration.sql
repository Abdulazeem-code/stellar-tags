-- CreateTable
CREATE TABLE "webhook_dlq" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "webhook_url" TEXT NOT NULL,
    "webhook_secret" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" TEXT NOT NULL,
    "failure_reason" TEXT NOT NULL,
    "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "moved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayed" BOOLEAN NOT NULL DEFAULT false,
    "replayed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_dlq_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_dlq_username_idx" ON "webhook_dlq"("username");

-- CreateIndex
CREATE INDEX "webhook_dlq_webhook_id_idx" ON "webhook_dlq"("webhook_id");

-- CreateIndex
CREATE INDEX "webhook_dlq_moved_at_idx" ON "webhook_dlq"("moved_at");
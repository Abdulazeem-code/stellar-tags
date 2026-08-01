-- CreateTable: webhooks for payment notifications
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sent_at" TIMESTAMP(3),
    "failing_since" TIMESTAMP(3),

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique constraint per user + url
CREATE UNIQUE INDEX "webhooks_username_url_key" ON "webhooks"("username", "url");

-- CreateIndex: lookup webhooks by username
CREATE INDEX "webhooks_username_idx" ON "webhooks"("username");

-- CreateIndex: lookup webhooks by last_sent_at for scheduling
CREATE INDEX "webhooks_last_sent_at_idx" ON "webhooks"("last_sent_at");

-- AddForeignKey: webhooks -> username_registry (cascade delete)
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_username_fkey" FOREIGN KEY ("username") REFERENCES "username_registry"("username") ON DELETE CASCADE ON UPDATE CASCADE;

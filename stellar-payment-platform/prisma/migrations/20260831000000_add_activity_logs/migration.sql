-- #599 — self-service user activity trail.
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- Serves the only read path: one user's trail, newest first.
CREATE INDEX "activity_logs_username_created_at_idx" ON "activity_logs"("username", "created_at");

ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_username_fkey" FOREIGN KEY ("username") REFERENCES "username_registry"("username") ON DELETE CASCADE ON UPDATE CASCADE;

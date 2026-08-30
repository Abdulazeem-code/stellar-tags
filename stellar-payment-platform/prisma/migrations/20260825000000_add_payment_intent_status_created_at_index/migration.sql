-- CreateIndex
-- Composite index for dashboard-style filtered list queries on payment_intents:
-- predicates like WHERE status = 'pending' AND created_at >= X (optionally
-- ORDER BY created_at DESC) resolve to a single index scan instead of a
-- full table scan.
CREATE INDEX "payment_intents_status_created_at_idx" ON "payment_intents"("status", "created_at");

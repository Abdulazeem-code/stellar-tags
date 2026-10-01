-- CreateIndex
-- Composite index backing the keyset (cursor) walk over the payments table
-- used by the admin export (issue #677): ORDER BY created_at ASC, id ASC with
-- the cursor predicate becomes an index seek, keeping deep pages O(log n)
-- instead of an OFFSET scan whose cost grows linearly with page depth.
CREATE INDEX "payments_created_at_id_idx" ON "payments"("created_at", "id");

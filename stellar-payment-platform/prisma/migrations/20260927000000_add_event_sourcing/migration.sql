-- Create Event Sourcing tables for Payment Ledger

-- Payment Events: Immutable append-only event store
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "aggregate_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT,
    "event_data" JSONB NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- Payment Read Models: Denormalized view derived from events
CREATE TABLE "payment_read_models" (
    "id" TEXT NOT NULL,
    "current_state" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "asset_code" TEXT,
    "transaction_hash" TEXT,
    "risk_score" DOUBLE PRECISION,
    "fraud_status" TEXT NOT NULL DEFAULT 'clear',
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_event_seq" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "payment_read_models_pkey" PRIMARY KEY ("id")
);

-- Event Checkpoints: Track last processed event for consumers
CREATE TABLE "event_checkpoints" (
    "id" TEXT NOT NULL,
    "consumer_name" TEXT NOT NULL,
    "last_event_id" TEXT NOT NULL,
    "last_sequence" INTEGER NOT NULL,
    "last_timestamp" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_checkpoints_pkey" PRIMARY KEY ("id")
);

-- Create indexes for payment_events
CREATE INDEX "payment_events_payment_id_idx" ON "payment_events"("payment_id");
CREATE INDEX "payment_events_event_type_idx" ON "payment_events"("event_type");
CREATE INDEX "payment_events_timestamp_idx" ON "payment_events"("timestamp");
CREATE INDEX "payment_events_aggregate_id_sequence_idx" ON "payment_events"("aggregate_id", "sequence");
CREATE UNIQUE INDEX "payment_events_aggregate_id_sequence_key" ON "payment_events"("aggregate_id", "sequence");

-- Create indexes for payment_read_models
CREATE INDEX "payment_read_models_current_state_idx" ON "payment_read_models"("current_state");
CREATE INDEX "payment_read_models_from_address_idx" ON "payment_read_models"("from_address");
CREATE INDEX "payment_read_models_to_address_idx" ON "payment_read_models"("to_address");
CREATE INDEX "payment_read_models_created_at_idx" ON "payment_read_models"("created_at");

-- Create unique index for event_checkpoints
CREATE UNIQUE INDEX "event_checkpoints_consumer_name_key" ON "event_checkpoints"("consumer_name");

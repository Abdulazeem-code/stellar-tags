-- Add custom merchant metadata to payment intents.
ALTER TABLE "payment_intents" ADD COLUMN "metadata" JSONB;

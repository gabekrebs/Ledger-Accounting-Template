-- Phase 3b — persisted category suggestions + Batch-API job tracking.
--
-- Trimmed to ONLY this change-set and made idempotent on purpose: drizzle's
-- generate also surfaced pre-existing snapshot drift (invoices / notes_receivable
-- / valuation columns already live in prod from earlier work). Those are left to
-- the snapshot reconciliation; this SQL applies only the genuinely-new delta, so
-- it is safe to run against prod by any path (IF NOT EXISTS throughout).

CREATE TABLE IF NOT EXISTS "bk_category_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anthropic_batch_id" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"suggestions_written" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"ingested_at" timestamp with time zone,
	CONSTRAINT "bk_category_batches_anthropic_batch_id_unique" UNIQUE("anthropic_batch_id")
);
--> statement-breakpoint
ALTER TABLE "bk_plaid_transactions" ADD COLUMN IF NOT EXISTS "suggested_account_id" uuid;--> statement-breakpoint
ALTER TABLE "bk_plaid_transactions" ADD COLUMN IF NOT EXISTS "suggested_confidence" numeric;--> statement-breakpoint
ALTER TABLE "bk_plaid_transactions" ADD COLUMN IF NOT EXISTS "suggested_reasoning" text;--> statement-breakpoint
ALTER TABLE "bk_plaid_transactions" ADD COLUMN IF NOT EXISTS "suggestion_source" text;--> statement-breakpoint
ALTER TABLE "bk_plaid_transactions" ADD COLUMN IF NOT EXISTS "suggested_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "bk_plaid_transactions" ADD CONSTRAINT "bk_plaid_transactions_suggested_account_id_bk_accounts_id_fk" FOREIGN KEY ("suggested_account_id") REFERENCES "public"."bk_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

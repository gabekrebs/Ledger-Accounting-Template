CREATE TABLE "bk_loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lender" text,
	"liability_account_qbo_id" text,
	"interest_account_qbo_id" text,
	"escrow_account_qbo_id" text,
	"funding_account_qbo_id" text,
	"original_principal_cents" bigint NOT NULL,
	"annual_rate_bps" integer NOT NULL,
	"term_months" integer NOT NULL,
	"start_date" date,
	"first_payment_date" date NOT NULL,
	"monthly_payment_cents" bigint,
	"monthly_escrow_cents" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "bk_loans" ADD CONSTRAINT "bk_loans_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE cascade ON UPDATE no action;
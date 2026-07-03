CREATE TABLE "bk_plaid_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"plaid_account_id" text NOT NULL,
	"name" text,
	"official_name" text,
	"mask" text,
	"type" text,
	"subtype" text,
	"mapped_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "bk_plaid_accounts_plaid_account_id_unique" UNIQUE("plaid_account_id")
);
--> statement-breakpoint
CREATE TABLE "bk_plaid_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"plaid_item_id" text NOT NULL,
	"access_token" text NOT NULL,
	"institution_id" text,
	"institution_name" text,
	"txn_cursor" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "bk_plaid_items_plaid_item_id_unique" UNIQUE("plaid_item_id")
);
--> statement-breakpoint
CREATE TABLE "bk_plaid_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"plaid_account_id" text NOT NULL,
	"plaid_transaction_id" text NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"txn_date" date NOT NULL,
	"name" text,
	"merchant_name" text,
	"amount_cents" bigint NOT NULL,
	"iso_currency_code" text,
	"plaid_category" jsonb,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"journal_entry_id" uuid,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "bk_plaid_transactions_plaid_transaction_id_unique" UNIQUE("plaid_transaction_id")
);
--> statement-breakpoint
ALTER TABLE "bk_plaid_accounts" ADD CONSTRAINT "bk_plaid_accounts_item_id_bk_plaid_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."bk_plaid_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_plaid_accounts" ADD CONSTRAINT "bk_plaid_accounts_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_plaid_accounts" ADD CONSTRAINT "bk_plaid_accounts_mapped_account_id_bk_accounts_id_fk" FOREIGN KEY ("mapped_account_id") REFERENCES "public"."bk_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_plaid_items" ADD CONSTRAINT "bk_plaid_items_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_plaid_transactions" ADD CONSTRAINT "bk_plaid_transactions_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_plaid_transactions" ADD CONSTRAINT "bk_plaid_transactions_journal_entry_id_bk_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."bk_journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bk_plaid_accounts_item_idx" ON "bk_plaid_accounts" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "bk_plaid_accounts_entity_idx" ON "bk_plaid_accounts" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "bk_plaid_items_entity_idx" ON "bk_plaid_items" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "bk_plaid_txns_entity_status_idx" ON "bk_plaid_transactions" USING btree ("entity_id","status");--> statement-breakpoint
CREATE INDEX "bk_plaid_txns_account_idx" ON "bk_plaid_transactions" USING btree ("plaid_account_id");--> statement-breakpoint
CREATE INDEX "bk_plaid_txns_date_idx" ON "bk_plaid_transactions" USING btree ("entity_id","txn_date");
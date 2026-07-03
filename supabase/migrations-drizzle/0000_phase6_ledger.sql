CREATE TABLE "bk_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"qbo_account_id" text NOT NULL,
	"name" text NOT NULL,
	"fully_qualified_name" text,
	"account_type" text NOT NULL,
	"account_subtype" text,
	"parent_qbo_id" text,
	"normal_balance" text NOT NULL,
	"classification" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "bk_accounts_entity_qbo_uq" UNIQUE("entity_id","qbo_account_id")
);
--> statement-breakpoint
CREATE TABLE "bk_journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"source" text NOT NULL,
	"qbo_txn_type" text,
	"qbo_txn_id" text,
	"txn_date" date NOT NULL,
	"doc_num" text,
	"name" text,
	"memo" text,
	"total_cents" bigint NOT NULL,
	"raw_qbo" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "bk_journal_entries_qbo_uq" UNIQUE("entity_id","qbo_txn_type","qbo_txn_id")
);
--> statement-breakpoint
CREATE TABLE "bk_journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"debit_cents" bigint DEFAULT 0 NOT NULL,
	"credit_cents" bigint DEFAULT 0 NOT NULL,
	"line_memo" text,
	CONSTRAINT "bk_journal_lines_debit_xor_credit" CHECK ("bk_journal_lines"."debit_cents" >= 0 AND "bk_journal_lines"."credit_cents" >= 0 AND NOT ("bk_journal_lines"."debit_cents" > 0 AND "bk_journal_lines"."credit_cents" > 0))
);
--> statement-breakpoint
CREATE TABLE "bk_ledger_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"realm_id" text NOT NULL,
	"name" text,
	"legal_name" text,
	"tax_type" text,
	"fiscal_year_start" text DEFAULT 'January',
	"imported_through" date,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "bk_ledger_entities_realm_id_unique" UNIQUE("realm_id")
);
--> statement-breakpoint
ALTER TABLE "bk_accounts" ADD CONSTRAINT "bk_accounts_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_journal_entries" ADD CONSTRAINT "bk_journal_entries_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_journal_lines" ADD CONSTRAINT "bk_journal_lines_entry_id_bk_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."bk_journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_journal_lines" ADD CONSTRAINT "bk_journal_lines_account_id_bk_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."bk_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bk_accounts_entity_idx" ON "bk_accounts" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "bk_journal_entries_entity_date_idx" ON "bk_journal_entries" USING btree ("entity_id","txn_date");--> statement-breakpoint
CREATE INDEX "bk_journal_lines_entry_idx" ON "bk_journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "bk_journal_lines_account_idx" ON "bk_journal_lines" USING btree ("account_id");
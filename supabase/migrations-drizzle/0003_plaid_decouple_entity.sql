ALTER TABLE "bk_plaid_accounts" DROP CONSTRAINT "bk_plaid_accounts_entity_id_bk_ledger_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "bk_plaid_items" DROP CONSTRAINT "bk_plaid_items_entity_id_bk_ledger_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "bk_plaid_transactions" DROP CONSTRAINT "bk_plaid_transactions_entity_id_bk_ledger_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "bk_plaid_accounts" ALTER COLUMN "entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bk_plaid_items" ALTER COLUMN "entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bk_plaid_transactions" ALTER COLUMN "entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bk_plaid_accounts" ADD CONSTRAINT "bk_plaid_accounts_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_plaid_items" ADD CONSTRAINT "bk_plaid_items_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_plaid_transactions" ADD CONSTRAINT "bk_plaid_transactions_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "bk_journal_entries" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bk_journal_entries" ADD COLUMN "edited_by" text;--> statement-breakpoint
CREATE TABLE "bk_journal_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_id" uuid,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"edited_at" timestamp with time zone DEFAULT now(),
	"edited_by" text
);
--> statement-breakpoint
ALTER TABLE "bk_journal_edits" ADD CONSTRAINT "bk_journal_edits_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_journal_edits" ADD CONSTRAINT "bk_journal_edits_entry_id_bk_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."bk_journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bk_journal_edits" ADD CONSTRAINT "bk_journal_edits_line_id_bk_journal_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."bk_journal_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bk_journal_edits_entry_idx" ON "bk_journal_edits" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "bk_journal_edits_entity_idx" ON "bk_journal_edits" USING btree ("entity_id");

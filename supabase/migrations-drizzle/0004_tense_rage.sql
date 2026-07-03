CREATE TABLE "bk_entity_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_email" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "bk_entity_access_email_entity_uq" UNIQUE("user_email","entity_id")
);
--> statement-breakpoint
ALTER TABLE "bk_entity_access" ADD CONSTRAINT "bk_entity_access_entity_id_bk_ledger_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."bk_ledger_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bk_entity_access_email_idx" ON "bk_entity_access" USING btree ("user_email");
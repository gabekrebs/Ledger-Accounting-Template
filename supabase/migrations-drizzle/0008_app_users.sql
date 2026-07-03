-- 0008_app_users: in-product user management (bk_app_users).
-- Hand-written + idempotent (drizzle snapshots are behind prod — see
-- bookkeeping-deploy notes; do NOT drizzle-kit generate, it sweeps drift).
-- Login gate admits env AUTH_ALLOWED_EMAILS ∪ active rows here; role 'admin'
-- = full access to every entity, 'member' = scoped by bk_entity_access.

CREATE TABLE IF NOT EXISTS "bk_app_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "display_name" text,
  "role" text DEFAULT 'member' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "created_by" text
);

DO $$ BEGIN
  ALTER TABLE "bk_app_users" ADD CONSTRAINT "bk_app_users_email_unique" UNIQUE ("email");
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "bk_app_users_email_idx" ON "bk_app_users" USING btree ("email");

-- Standing rule (2026-06-09 CSO audit): every new bk_ table ships with RLS on
-- and zero PostgREST grants — the app reads it via the service-role client only.
ALTER TABLE "bk_app_users" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "bk_app_users" FROM anon, authenticated;

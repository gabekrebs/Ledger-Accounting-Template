import { defineConfig } from "drizzle-kit";
import fs from "fs";

// Load SUPABASE_DB_URL from .env.local (drizzle-kit runs outside Next).
function dbUrl(): string {
  if (process.env.SUPABASE_DB_URL) {
    return process.env.SUPABASE_DB_URL.trim().replace(/\\n$/, "");
  }
  const txt = fs.readFileSync(".env.local", "utf8");
  const m = txt.match(/^SUPABASE_DB_URL=(.*)$/m);
  if (!m) throw new Error("SUPABASE_DB_URL not found");
  return m[1].trim().replace(/\\n$/, "");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./supabase/migrations-drizzle",
  dbCredentials: { url: dbUrl() },
  // Only manage the Phase 6 ledger tables — never touch the existing bk_* /
  // external tables Drizzle does not manage.
  tablesFilter: [
    "bk_entity_access",
    "bk_ledger_entities",
    "bk_accounts",
    "bk_journal_entries",
    "bk_journal_lines",
    "bk_loans",
    "bk_plaid_items",
    "bk_plaid_accounts",
    "bk_plaid_transactions",
    "bk_category_batches",
    "bk_notes_receivable",
    "bk_invoice_templates",
    "bk_invoices",
  ],
});

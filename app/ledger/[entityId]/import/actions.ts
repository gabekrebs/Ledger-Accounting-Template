"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import postgres from "postgres";
import { assertEntityAccess } from "@/lib/ledger/access";
import { parseWaveCsv, importWaveEntries, type WavePreview } from "@/lib/ledger/wave-import";
import {
  parseWaveBalancesCsv,
  importWaveBalances,
  type WaveBalancesPreview,
} from "@/lib/ledger/wave-balance-import";
import {
  diagnoseBalanceHealth,
  deleteAllFlaggedOpeningEntries,
} from "@/lib/ledger/balance-health";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface BalancesPreviewResult {
  ok: boolean;
  error?: string;
  preview?: WaveBalancesPreview;
}

export interface TxnPreviewResult {
  ok: boolean;
  error?: string;
  preview?: WavePreview;
}

// Keep legacy alias
export type PreviewResult = TxnPreviewResult;

export interface ImportRecord {
  id: string;
  importType: string;
  importedAt: string;
  periodEnd: string | null;
  accountsSynced: number;
  entriesInserted: number;
  entriesSkipped: number;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Import history helpers (raw SQL — bk_wave_imports not in Drizzle schema yet)
// ---------------------------------------------------------------------------

function pgClient() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL not configured");
  return postgres(url, { max: 1, idle_timeout: 5 });
}

export async function getImportHistory(entityId: string): Promise<ImportRecord[]> {
  try {
    await assertEntityAccess(entityId);
    const pg = pgClient();
    const rows = await pg<{
      id: string;
      import_type: string;
      imported_at: string;
      period_end: string | null;
      accounts_synced: number;
      entries_inserted: number;
      entries_skipped: number;
      notes: string | null;
    }[]>`
      SELECT id, import_type, imported_at, period_end, accounts_synced,
             entries_inserted, entries_skipped, notes
      FROM bk_wave_imports
      WHERE entity_id = ${entityId}
      ORDER BY imported_at DESC
      LIMIT 20
    `;
    await pg.end();
    return rows.map((r) => ({
      id: r.id,
      importType: r.import_type,
      importedAt: r.imported_at,
      periodEnd: r.period_end,
      accountsSynced: r.accounts_synced,
      entriesInserted: r.entries_inserted,
      entriesSkipped: r.entries_skipped,
      notes: r.notes,
    }));
  } catch {
    return [];
  }
}

async function recordImport(
  entityId: string,
  importType: string,
  periodEnd: string | null,
  accountsSynced: number,
  entriesInserted: number,
  entriesSkipped: number,
  notes?: string
) {
  try {
    const pg = pgClient();
    await pg`
      INSERT INTO bk_wave_imports
        (entity_id, import_type, period_end, accounts_synced, entries_inserted, entries_skipped, notes)
      VALUES
        (${entityId}, ${importType}, ${periodEnd}, ${accountsSynced},
         ${entriesInserted}, ${entriesSkipped}, ${notes ?? null})
    `;
    await pg.end();
  } catch (e) {
    console.error("Failed to record import history:", e);
  }
}

// ---------------------------------------------------------------------------
// Account Balances actions
// ---------------------------------------------------------------------------

export async function previewBalancesImport(
  entityId: string,
  csv: string
): Promise<BalancesPreviewResult> {
  try {
    await assertEntityAccess(entityId);
    const result = parseWaveBalancesCsv(csv);
    return { ok: true, preview: result.preview };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function commitBalancesImport(
  entityId: string,
  csv: string
): Promise<{ ok: false; error: string } | { ok: true; inserted: number; skipped: number; asOfDate: string }> {
  await assertEntityAccess(entityId);
  const result = parseWaveBalancesCsv(csv);

  if (result.preview.errors.length > 0) {
    return { ok: false, error: result.preview.errors.join("; ") };
  }

  const r = await importWaveBalances(entityId, result);
  if (r.error) return { ok: false, error: r.error };

  await recordImport(
    entityId, "balances", result.asOfDate,
    result.accounts.length, r.inserted, r.skipped,
    `Opening balances as of ${result.asOfDate}`
  );
  revalidatePath(`/ledger/${entityId}`);
  return { ok: true, inserted: r.inserted, skipped: r.skipped, asOfDate: result.asOfDate };
}

// ---------------------------------------------------------------------------
// Account Transactions actions
// ---------------------------------------------------------------------------

export async function previewWaveImport(
  entityId: string,
  csv: string
): Promise<TxnPreviewResult> {
  try {
    await assertEntityAccess(entityId);
    const result = parseWaveCsv(csv);
    return { ok: true, preview: result.preview };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function commitWaveImport(
  entityId: string,
  csv: string
): Promise<{ ok: false; error: string } | never> {
  await assertEntityAccess(entityId);
  const result = parseWaveCsv(csv);

  if (result.preview.errors.length > 0) {
    return { ok: false, error: result.preview.errors.join("; ") };
  }

  const r = await importWaveEntries(entityId, result);
  if (r.errors.length > 0) return { ok: false, error: r.errors.slice(0, 3).join("; ") };

  await recordImport(
    entityId, "transactions",
    result.preview.dateMax || null,
    result.preview.accounts,
    r.inserted, r.skipped,
    `Transactions ${result.preview.dateMin} – ${result.preview.dateMax}`
  );
  revalidatePath(`/ledger/${entityId}`);
  redirect(`/ledger/${entityId}/transactions`);
}

// Wizard variant — same import but returns a result instead of redirecting.
export async function commitWaveImportWizard(
  entityId: string,
  csv: string
): Promise<{ ok: false; error: string } | { ok: true; inserted: number; skipped: number; dateMin: string; dateMax: string }> {
  await assertEntityAccess(entityId);
  const result = parseWaveCsv(csv);

  if (result.preview.errors.length > 0) {
    return { ok: false, error: result.preview.errors.join("; ") };
  }

  const r = await importWaveEntries(entityId, result);
  if (r.errors.length > 0) return { ok: false, error: r.errors.slice(0, 3).join("; ") };

  await recordImport(
    entityId, "transactions",
    result.preview.dateMax || null,
    result.preview.accounts,
    r.inserted, r.skipped,
    `Transactions ${result.preview.dateMin} – ${result.preview.dateMax}`
  );
  revalidatePath(`/ledger/${entityId}`);
  return {
    ok: true,
    inserted: r.inserted,
    skipped: r.skipped,
    dateMin: result.preview.dateMin ?? "",
    dateMax: result.preview.dateMax ?? "",
  };
}

// Balance health — exposed as server actions for the wizard
export async function checkHealth(entityId: string) {
  return diagnoseBalanceHealth(entityId);
}

export async function fixHealth(entityId: string) {
  return deleteAllFlaggedOpeningEntries(entityId);
}

// Account activity — fetch P&L accounts for activity tagging after import
export async function getImportedAccounts(entityId: string): Promise<
  { id: string; name: string; classification: string; activity: string }[]
> {
  await assertEntityAccess(entityId);
  const { db, schema } = await import("@/lib/db/client");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({
      id: schema.bkAccounts.id,
      name: schema.bkAccounts.name,
      classification: schema.bkAccounts.classification,
      activity: schema.bkAccounts.activity,
    })
    .from(schema.bkAccounts)
    .where(eq(schema.bkAccounts.entityId, entityId))
    .orderBy(schema.bkAccounts.classification, schema.bkAccounts.name);
  return rows.filter((r) => r.classification === "revenue" || r.classification === "expense");
}

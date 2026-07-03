import { NextRequest, NextResponse } from "next/server";
import { assertEntityAccess } from "@/lib/ledger/access";
import { parseWaveCsv, importWaveEntries } from "@/lib/ledger/wave-import";
import {
  parseWaveBalancesCsv,
  importWaveBalances,
} from "@/lib/ledger/wave-balance-import";
import postgres from "postgres";
import { revalidatePath } from "next/cache";

function pgClient() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL not configured");
  return postgres(url, { max: 1, idle_timeout: 5 });
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
  // bk_wave_imports is history-log only and not in the drizzle schema, so this
  // uses a one-off client — closed in FINALLY so a failed insert can't leak
  // the connection.
  let pg: ReturnType<typeof pgClient> | null = null;
  try {
    pg = pgClient();
    await pg`
      INSERT INTO bk_wave_imports
        (entity_id, import_type, period_end, accounts_synced, entries_inserted, entries_skipped, notes)
      VALUES
        (${entityId}, ${importType}, ${periodEnd}, ${accountsSynced},
         ${entriesInserted}, ${entriesSkipped}, ${notes ?? null})
    `;
  } catch (e) {
    console.error("Failed to record import history:", e);
  } finally {
    await pg?.end().catch(() => {});
  }
}

/**
 * Request-size ceiling for a Wave CSV upload. Years of Wave transaction
 * history run a few MB; 15 MB is far above any legitimate export while
 * keeping a clear 413 instead of buffering unbounded input. (Vercel
 * additionally caps serverless request bodies platform-side.)
 */
const MAX_CSV_BYTES = 15 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_CSV_BYTES) {
      return NextResponse.json(
        { ok: false, error: `Upload too large (max ${MAX_CSV_BYTES / 1024 / 1024} MB)` },
        { status: 413 }
      );
    }
    const { action, entityId, csv } = await req.json();
    if (typeof csv === "string" && csv.length > MAX_CSV_BYTES) {
      return NextResponse.json(
        { ok: false, error: `CSV too large (max ${MAX_CSV_BYTES / 1024 / 1024} MB)` },
        { status: 413 }
      );
    }
    await assertEntityAccess(entityId);

    if (action === "preview-txn") {
      const result = parseWaveCsv(csv);
      return NextResponse.json({ ok: true, preview: result.preview });
    }

    if (action === "commit-txn") {
      const result = parseWaveCsv(csv);
      if (result.preview.errors.length > 0) {
        return NextResponse.json({ ok: false, error: result.preview.errors.join("; ") });
      }
      const r = await importWaveEntries(entityId, result);
      if (r.errors.length > 0) {
        return NextResponse.json({ ok: false, error: r.errors.slice(0, 3).join("; ") });
      }
      await recordImport(
        entityId, "transactions",
        result.preview.dateMax || null,
        result.preview.accounts,
        r.inserted, r.skipped,
        `Transactions ${result.preview.dateMin} – ${result.preview.dateMax}`
      );
      revalidatePath(`/ledger/${entityId}`);
      return NextResponse.json({
        ok: true,
        inserted: r.inserted,
        skipped: r.skipped,
        dateMin: result.preview.dateMin ?? "",
        dateMax: result.preview.dateMax ?? "",
      });
    }

    if (action === "preview-bal") {
      const result = parseWaveBalancesCsv(csv);
      return NextResponse.json({ ok: true, preview: result.preview });
    }

    if (action === "commit-bal") {
      const result = parseWaveBalancesCsv(csv);
      if (result.preview.errors.length > 0) {
        return NextResponse.json({ ok: false, error: result.preview.errors.join("; ") });
      }
      const r = await importWaveBalances(entityId, result);
      if (r.error) return NextResponse.json({ ok: false, error: r.error });
      await recordImport(
        entityId, "balances", result.asOfDate,
        result.accounts.length, r.inserted, r.skipped,
        `Opening balances as of ${result.asOfDate}`
      );
      revalidatePath(`/ledger/${entityId}`);
      return NextResponse.json({
        ok: true,
        inserted: r.inserted,
        skipped: r.skipped,
        asOfDate: result.asOfDate,
      });
    }

    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

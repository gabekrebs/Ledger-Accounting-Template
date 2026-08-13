import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { canAccessEntity } from "@/lib/ledger/access";
import { buildTrialBalance } from "@/lib/ledger/trial-balance";
import { toCsv, toXlsx } from "@/lib/ledger/trial-balance-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /ledger/{entityId}/accounts/trial-balance?year=2025&format=xlsx|csv
 *
 * The CPA year-end workpaper download — a signed trial balance (dr +, cr −)
 * with dynamic per-activity columns (see lib/ledger/trial-balance.ts). Session
 * auth + entity access, same gate as the pages; existence of other entities is
 * never confirmed (plain 404).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ entityId: string }> }
) {
  const { entityId } = await params;
  const user = await getCurrentUser();
  if (!user?.email || !(await canAccessEntity(user.email, entityId))) {
    return new Response("Not found", { status: 404 });
  }

  const yearParam = request.nextUrl.searchParams.get("year");
  const year = Number(yearParam);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return new Response("Invalid year", { status: 400 });
  }
  const format = request.nextUrl.searchParams.get("format") ?? "xlsx";
  if (format !== "xlsx" && format !== "csv") {
    return new Response("Invalid format", { status: 400 });
  }

  const [entity] = await db
    .select({ name: schema.bkLedgerEntities.name })
    .from(schema.bkLedgerEntities)
    .where(eq(schema.bkLedgerEntities.id, entityId));
  const entityName = entity?.name ?? "Entity";

  const tb = await buildTrialBalance(entityId, year);
  const slug = entityName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filename = `${slug}-trial-balance-${year}.${format}`;

  if (format === "csv") {
    const body = toCsv(entityName, tb);
    return new Response(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  }

  const buffer = await toXlsx(entityName, tb);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}


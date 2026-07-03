"use server";

/**
 * Balance-sheet health check — detects when both an Account Balances opening
 * entry AND full Account Transactions were imported for the same entity,
 * causing every account balance to be doubled.
 *
 * Algorithm: for each "WaveBalances" opening entry, compare its per-account
 * contribution to the account's current total balance.
 *   ratio = currentNetCents / entryContributionCents
 *   ratio ≈ 2  → account appears doubled (opening entry + transactions overlap)
 *   ratio ≈ 1  → account only has the opening entry as its source
 *
 * If >60% of the opening entry's dollars are in doubled accounts, the entry is
 * redundant and safe to delete — the Account Transactions already carry the
 * full history.
 */

import { eq, and, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db/client";
import { assertEntityAccess } from "@/lib/ledger/access";

const { bkAccounts, bkJournalEntries, bkJournalLines } = schema;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AccountIssue {
  accountName: string;
  classification: string;
  openingCents: number;  // absolute amount from the opening entry
  currentCents: number;  // absolute current balance
  ratio: number;         // currentCents / openingCents (≈2 = doubled)
}

export interface OpeningEntryIssue {
  entryId: string;
  txnDate: string;
  entryName: string;
  doubledAccounts: AccountIssue[];
  otherAccounts: AccountIssue[];
  /** Fraction (0–1) of the entry's total dollars that appear doubled. */
  confidenceFraction: number;
  recommendation: "delete" | "keep" | "review";
}

export interface BalanceHealthResult {
  hasIssues: boolean;
  issues: OpeningEntryIssue[];
  /** Plain-English summary shown at the top of the panel. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Diagnose
// ---------------------------------------------------------------------------

export async function diagnoseBalanceHealth(
  entityId: string
): Promise<BalanceHealthResult> {
  await assertEntityAccess(entityId);

  // 1. Find all WaveBalances opening entries for this entity
  const openingEntries = await db
    .select({
      id: bkJournalEntries.id,
      txnDate: bkJournalEntries.txnDate,
      name: bkJournalEntries.name,
    })
    .from(bkJournalEntries)
    .where(
      and(
        eq(bkJournalEntries.entityId, entityId),
        eq(bkJournalEntries.qboTxnType, "WaveBalances")
      )
    );

  if (!openingEntries.length) {
    return {
      hasIssues: false,
      issues: [],
      summary: "No opening balance entries — nothing to check.",
    };
  }

  const openingIds = openingEntries.map((e) => e.id);

  // 2. Get every line of those opening entries, with account info
  const openingLines = await db
    .select({
      entryId: bkJournalLines.entryId,
      accountId: bkJournalLines.accountId,
      accountName: bkAccounts.name,
      classification: bkAccounts.classification,
      debitCents: bkJournalLines.debitCents,
      creditCents: bkJournalLines.creditCents,
    })
    .from(bkJournalLines)
    .innerJoin(bkAccounts, eq(bkJournalLines.accountId, bkAccounts.id))
    .where(inArray(bkJournalLines.entryId, openingIds));

  // 3. Get the CURRENT full balance for every account referenced in the opening entries
  const accountIds = [...new Set(openingLines.map((l) => l.accountId))];

  const currentBalances = await db
    .select({
      accountId: bkJournalLines.accountId,
      netCents:
        sql<number>`SUM(${bkJournalLines.debitCents} - ${bkJournalLines.creditCents})::bigint`.as(
          "net_cents"
        ),
    })
    .from(bkJournalLines)
    .innerJoin(bkJournalEntries, eq(bkJournalLines.entryId, bkJournalEntries.id))
    .where(
      and(
        inArray(bkJournalLines.accountId, accountIds),
        eq(bkJournalEntries.entityId, entityId)
      )
    )
    .groupBy(bkJournalLines.accountId);

  const currentByAccount = new Map(
    currentBalances.map((r) => [r.accountId, r.netCents])
  );

  // 4. Analyse each opening entry
  const issues: OpeningEntryIssue[] = [];

  for (const entry of openingEntries) {
    const lines = openingLines.filter((l) => l.entryId === entry.id);

    const doubled: AccountIssue[] = [];
    const other: AccountIssue[] = [];

    for (const l of lines) {
      const contribution = l.debitCents - l.creditCents; // signed
      if (contribution === 0) continue;

      const currentNet = currentByAccount.get(l.accountId) ?? 0;
      const openingAbs = Math.abs(contribution);
      const currentAbs = Math.abs(currentNet);
      const ratio = openingAbs > 0 ? currentAbs / openingAbs : 1;

      const item: AccountIssue = {
        accountName: l.accountName,
        classification: l.classification,
        openingCents: openingAbs,
        currentCents: currentAbs,
        ratio: Math.round(ratio * 100) / 100,
      };

      // Doubled: ratio within 15% of 2.0
      if (ratio >= 1.7 && ratio <= 2.4) {
        doubled.push(item);
      } else {
        other.push(item);
      }
    }

    const totalOpeningCents = [...doubled, ...other].reduce(
      (s, a) => s + a.openingCents,
      0
    );
    const doubledCents = doubled.reduce((s, a) => s + a.openingCents, 0);
    const confidenceFraction =
      totalOpeningCents > 0 ? doubledCents / totalOpeningCents : 0;

    const recommendation: "delete" | "keep" | "review" =
      confidenceFraction >= 0.6
        ? "delete"
        : confidenceFraction >= 0.3
        ? "review"
        : "keep";

    if (recommendation !== "keep") {
      issues.push({
        entryId: entry.id,
        txnDate: entry.txnDate,
        entryName: entry.name ?? `Opening balances as of ${entry.txnDate}`,
        doubledAccounts: doubled.sort((a, b) => b.openingCents - a.openingCents),
        otherAccounts: other,
        confidenceFraction,
        recommendation,
      });
    }
  }

  const hasIssues = issues.some((i) => i.recommendation === "delete");

  const summary = hasIssues
    ? `Found ${issues.filter((i) => i.recommendation === "delete").length} opening balance ` +
      `entr${issues.length === 1 ? "y" : "ies"} that appear to double-count balances already present ` +
      `in the transaction history. Deleting them will correct the totals.`
    : issues.length > 0
    ? "One or more opening entries may partially overlap with transactions — review before deciding."
    : "Balance sheet looks clean — no double-counting detected.";

  return { hasIssues, issues, summary };
}

// ---------------------------------------------------------------------------
// Fix — delete one or all flagged opening entries
// ---------------------------------------------------------------------------

export async function deleteOpeningEntry(
  entityId: string,
  entryId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await assertEntityAccess(entityId);

    // Verify the entry belongs to this entity and is a WaveBalances entry
    const [entry] = await db
      .select({ id: bkJournalEntries.id })
      .from(bkJournalEntries)
      .where(
        and(
          eq(bkJournalEntries.id, entryId),
          eq(bkJournalEntries.entityId, entityId),
          eq(bkJournalEntries.qboTxnType, "WaveBalances")
        )
      );

    if (!entry) return { ok: false, error: "Opening entry not found for this entity." };

    // Delete entry — journal lines cascade automatically
    await db.delete(bkJournalEntries).where(eq(bkJournalEntries.id, entryId));

    revalidatePath(`/ledger/${entityId}`);
    revalidatePath(`/ledger/${entityId}/import`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteAllFlaggedOpeningEntries(
  entityId: string
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  try {
    await assertEntityAccess(entityId);
    const diagnosis = await diagnoseBalanceHealth(entityId);
    const toDelete = diagnosis.issues.filter((i) => i.recommendation === "delete");

    for (const issue of toDelete) {
      await db
        .delete(bkJournalEntries)
        .where(
          and(
            eq(bkJournalEntries.id, issue.entryId),
            eq(bkJournalEntries.entityId, entityId)
          )
        );
    }

    revalidatePath(`/ledger/${entityId}`);
    revalidatePath(`/ledger/${entityId}/import`);
    return { ok: true, deleted: toDelete.length };
  } catch (e) {
    return {
      ok: false,
      deleted: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

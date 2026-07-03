"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  postPlaidTransaction,
  postPlaidTransactionEntry,
  ignorePlaidTransaction,
  unpostPlaidTransaction,
  type PostLine,
} from "@/lib/plaid/post";
import { autoPostEntity } from "@/lib/plaid/auto-post";
import { suppressBookedNearMatches } from "@/lib/plaid/reconcile";
import {
  suggestCategories,
  type SuggestCategoriesResult,
} from "@/lib/plaid/suggest-categories";
import { assertEntityAccess } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  applyRuleOnce,
  applyRuleToPending,
  applyRuleRetroactive,
} from "@/lib/rules/admin";
import { recordRuleOutcome } from "@/lib/rules/learn";
import {
  assertTxnInEntity,
  assertPlaidAccountInEntity,
  assertAccountInEntity,
} from "@/lib/rules/authz";

const { bkPlaidAccounts } = schema;

async function actorEmail(): Promise<string | null> {
  return (await getCurrentUser())?.email ?? null;
}

/** Apply the matched rule to THIS transaction (review-row "Apply here"). */
export async function applyRuleHere(
  entityId: string,
  ruleId: string,
  txnId: string
): Promise<{ ok: boolean; error?: string }> {
  await assertEntityAccess(entityId);
  try {
    await applyRuleOnce(ruleId, txnId, entityId, await actorEmail());
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath(`/ledger/${entityId}/bank`);
  revalidatePath(`/ledger/${entityId}`);
  return { ok: true };
}

/** Apply the matched rule to every still-pending match (review-row "Apply to similar"). */
export async function applyRuleSimilar(
  entityId: string,
  ruleId: string
): Promise<{ ok: boolean; error?: string; applied?: number; errors?: number }> {
  await assertEntityAccess(entityId);
  try {
    const r = await applyRuleToPending(ruleId, entityId, await actorEmail());
    revalidatePath(`/ledger/${entityId}/bank`);
    revalidatePath(`/ledger/${entityId}`);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Retroactively re-categorize already-posted matches (review-row "Apply retroactively"). */
export async function applyRuleRetroReview(
  entityId: string,
  ruleId: string
): Promise<{ ok: boolean; error?: string; updated?: number; refused?: number; skipped?: number }> {
  await assertEntityAccess(entityId);
  try {
    const r = await applyRuleRetroactive(ruleId, entityId, await actorEmail());
    revalidatePath(`/ledger/${entityId}/bank`);
    revalidatePath(`/ledger/${entityId}`);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Map (or unmap) a linked bank account to a ledger account. */
export async function mapAccount(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const plaidAccountRowId = String(formData.get("plaidAccountRowId"));
  const mapped = String(formData.get("mappedAccountId") ?? "");

  // Bind both ids to the authorized entity: the Plaid-account row and the ledger
  // account it maps to must belong to entityId (else a user could re-map another
  // entity's bank account).
  await assertPlaidAccountInEntity(plaidAccountRowId, entityId);
  if (mapped.length) await assertAccountInEntity(mapped, entityId);

  await db
    .update(bkPlaidAccounts)
    .set({
      mappedAccountId: mapped.length ? mapped : null,
      updatedAt: new Date(),
    })
    .where(eq(bkPlaidAccounts.id, plaidAccountRowId));

  revalidatePath(`/ledger/${entityId}/bank`);
}

/** Categorize + post a staged transaction into the ledger. */
export async function postTransaction(
  formData: FormData
): Promise<{ ok: boolean; error?: string; learning?: string }> {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const txnId = String(formData.get("txnId"));
  const categoryAccountId = String(formData.get("categoryAccountId") ?? "");
  // Optional clean vendor/payee — empty means keep the Plaid descriptor.
  const payee = String(formData.get("payee") ?? "").trim() || null;
  if (!categoryAccountId) {
    return { ok: false, error: "Pick a category first" };
  }
  try {
    // The txn must belong to the authorized entity — a foreign txnId would
    // otherwise post into another entity's books.
    await assertTxnInEntity(txnId, entityId);
    // Capture the rule that pre-filled this row BEFORE posting flips it off
    // pending_review — so we can record a confirmation/correction against it.
    const [row] = await db
      .select({
        matchedRuleId: schema.bkPlaidTransactions.matchedRuleId,
        amountCents: schema.bkPlaidTransactions.amountCents,
      })
      .from(schema.bkPlaidTransactions)
      .where(eq(schema.bkPlaidTransactions.id, txnId));
    const actor = row?.matchedRuleId ? await actorEmail() : null;
    // Atomic: the ledger post AND the rule-learning (confirmation/correction,
    // graduation/demotion, audit event) commit or roll back together — a failure
    // in learning can no longer leave the books changed while the action errors.
    const learning = await db.transaction(async (tx) => {
      const { journalEntryId } = await postPlaidTransaction(
        txnId,
        categoryAccountId,
        "plaid",
        payee,
        tx
      );
      if (!row?.matchedRuleId) return undefined;
      const out = await recordRuleOutcome({
        ruleId: row.matchedRuleId,
        entityId,
        chosenAccountId: categoryAccountId,
        absAmountCents: Math.abs(Number(row.amountCents)),
        journalEntryId,
        actor,
        tx,
      });
      return out.explanation || undefined;
    });
    revalidatePath(`/ledger/${entityId}/bank`);
    revalidatePath(`/ledger/${entityId}`);
    return { ok: true, learning };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Post a staged transaction as a MULTI-LINE journal entry — the general split
 * path. The caller supplies every non-bank line (account + an explicit debit OR
 * credit); the bank line for the txn amount is added on its natural side and the
 * whole entry must balance. For any split a single category can't express.
 */
export async function postEntryTransaction(input: {
  entityId: string;
  txnId: string;
  lines: PostLine[];
  payee?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const { entityId, txnId, lines } = input;
  await assertEntityAccess(entityId);
  const payee = input.payee?.trim() || null;
  if (!lines?.length) {
    return { ok: false, error: "Add at least one line" };
  }
  try {
    await assertTxnInEntity(txnId, entityId); // foreign txnId guard
    await postPlaidTransactionEntry(txnId, lines, "plaid", payee);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath(`/ledger/${entityId}/bank`);
  revalidatePath(`/ledger/${entityId}`);
  return { ok: true };
}

/** Drop a staged transaction from the review inbox without posting. */
export async function ignoreTransaction(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const txnId = String(formData.get("txnId"));
  await assertTxnInEntity(txnId, entityId); // foreign txnId guard
  await ignorePlaidTransaction(txnId);
  revalidatePath(`/ledger/${entityId}/bank`);
}

/**
 * Bulk-resolve every pending txn flagged "already in QuickBooks/Wave" (the
 * near-matches the UI shows with Post disabled) — one click instead of one
 * Ignore per row. Idempotent; returns how many were resolved.
 */
export async function ignoreAlreadyBooked(
  entityId: string
): Promise<{ ignored: number }> {
  await assertEntityAccess(entityId);
  const ignored = await suppressBookedNearMatches(entityId);
  revalidatePath(`/ledger/${entityId}/bank`);
  return { ignored };
}

/** Reverse a posted transaction (undo) — returns it to the review inbox. */
export async function unpostTransaction(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const txnId = String(formData.get("txnId"));
  try {
    await assertTxnInEntity(txnId, entityId); // foreign txnId guard (this DELETES a journal entry)
    await unpostPlaidTransaction(txnId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath(`/ledger/${entityId}/bank`);
  revalidatePath(`/ledger/${entityId}`);
  return { ok: true };
}

/**
 * Deterministically auto-post the high-confidence transactions for this entity
 * (no AI) and report the counts. Safe to re-run — idempotent. Same engine the
 * threshold-triggered portfolio batch will call.
 */
export async function autoCategorize(
  entityId: string
): Promise<{ posted: number; skippedDup: number; errors: number }> {
  await assertEntityAccess(entityId);
  const r = await autoPostEntity(entityId);
  revalidatePath(`/ledger/${entityId}/bank`);
  revalidatePath(`/ledger/${entityId}`);
  return { posted: r.posted, skippedDup: r.skippedDup, errors: r.errors };
}

/**
 * Suggest categories for the still-pending transactions (free history pre-pass
 * + Haiku for the leftovers). Pre-fills the review dropdowns; writes nothing.
 */
export async function suggestCategoriesAction(
  entityId: string
): Promise<SuggestCategoriesResult> {
  await assertEntityAccess(entityId);
  return suggestCategories(entityId);
}

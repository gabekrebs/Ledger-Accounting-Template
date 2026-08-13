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
import {
  assertEntityAccess,
  assertEntityWrite,
  assertOwner,
} from "@/lib/ledger/access";
import { logAudit } from "@/lib/ledger/audit";
import { limitAction } from "@/lib/security/rate-limit";
import { actionIdentity } from "@/lib/security/rate-limit-identity";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  applyRuleOnce,
  applyRuleToPending,
  applyRuleRetroactive,
} from "@/lib/rules/admin";
import { recordRuleOutcome } from "@/lib/rules/learn";
import {
  recordSuggestionDecision,
  recordAutoPostReversal,
  maybeProposeRuleFromAiAccepts,
} from "@/lib/ai/events";
import { lockBucket } from "@/lib/ai/calibration";
import { annotateOwnerCategory } from "@/lib/ai/merchant-intel";
import {
  assertTxnInEntity,
  assertPlaidAccountInEntity,
  assertAccountInEntity,
} from "@/lib/rules/authz";

const { bkPlaidAccounts } = schema;

/**
 * Post-commit learning side effects for a decided suggestion — never allowed
 * to fail the posting itself. Locks the bucket on a correction of an unlocked
 * bucket is NOT needed here (corrections only lock buckets when the post was
 * an AI AUTO-post; a human correcting a mere suggestion is exactly the shadow
 * data we want). Feeds merchant intel + the 2-accepts→rule loop.
 */
async function afterSuggestionDecision(
  entityId: string,
  decision: Awaited<ReturnType<typeof recordSuggestionDecision>>,
  postedAccountId: string
): Promise<void> {
  try {
    if (!decision.outcome || !decision.merchantKey) return;
    const [acct] = await db
      .select({
        name: schema.bkAccounts.name,
        fqn: schema.bkAccounts.fullyQualifiedName,
      })
      .from(schema.bkAccounts)
      .where(eq(schema.bkAccounts.id, postedAccountId));
    const label = acct?.fqn ?? acct?.name ?? "";
    if (label) await annotateOwnerCategory(decision.merchantKey, label);
    if (decision.outcome === "accepted" && decision.source === "ai") {
      await maybeProposeRuleFromAiAccepts({
        entityId,
        merchantKey: decision.merchantKey,
        accountId: postedAccountId,
        accountLabel: label || "category",
      });
    }
  } catch (e) {
    console.error("suggestion learning side effects failed:", e);
  }
}

async function actorEmail(): Promise<string | null> {
  return (await getCurrentUser())?.email ?? null;
}

/** Apply the matched rule to THIS transaction (review-row "Apply here"). */
export async function applyRuleHere(
  entityId: string,
  ruleId: string,
  txnId: string
): Promise<{ ok: boolean; error?: string }> {
  await assertEntityWrite(entityId);
  try {
    await applyRuleOnce(ruleId, txnId, entityId, await actorEmail());
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await logAudit({
    entityId,
    actionType: "apply_rule_here",
    objectTable: "bk_plaid_transactions",
    objectId: txnId,
    description: "Applied a rule to a pending transaction",
    affectedLedger: true,
  });
  revalidatePath(`/ledger/${entityId}/bank`);
  revalidatePath(`/ledger/${entityId}`);
  return { ok: true };
}

/** Apply the matched rule to every still-pending match (review-row "Apply to similar"). */
export async function applyRuleSimilar(
  entityId: string,
  ruleId: string
): Promise<{ ok: boolean; error?: string; applied?: number; errors?: number }> {
  await assertEntityWrite(entityId);
  try {
    const r = await applyRuleToPending(ruleId, entityId, await actorEmail());
    await logAudit({
      entityId,
      actionType: "apply_rule_similar",
      objectTable: "bk_rules",
      objectId: ruleId,
      description: `Applied a rule to ${r.applied ?? 0} similar pending transactions`,
      affectedLedger: true,
    });
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
  await assertEntityWrite(entityId);
  try {
    const r = await applyRuleRetroactive(ruleId, entityId, await actorEmail());
    await logAudit({
      entityId,
      actionType: "apply_rule_retroactive",
      objectTable: "bk_rules",
      objectId: ruleId,
      description: `Retroactively recategorized ${r.updated ?? 0} posted transactions`,
      affectedLedger: true,
    });
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
  await assertEntityWrite(entityId);
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

  await logAudit({
    entityId,
    actionType: "map_bank_account",
    objectTable: "bk_plaid_accounts",
    objectId: plaidAccountRowId,
    description: mapped.length
      ? "Mapped a bank account to a ledger account"
      : "Unmapped a bank account",
    affectedLedger: false,
  });
  revalidatePath(`/ledger/${entityId}/bank`);
}

/** Categorize + post a staged transaction into the ledger. */
export async function postTransaction(
  formData: FormData
): Promise<{ ok: boolean; error?: string; learning?: string }> {
  const entityId = String(formData.get("entityId"));
  await assertEntityWrite(entityId);
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
    const actor = await actorEmail();
    // Atomic: the ledger post AND the learning writes (rule confirmation/
    // correction, suggestion-outcome stamp) commit or roll back together — a
    // failure in learning can no longer leave the books changed while the
    // action errors.
    const { learning, decision } = await db.transaction(async (tx) => {
      const { journalEntryId } = await postPlaidTransaction(
        txnId,
        categoryAccountId,
        "plaid",
        payee,
        tx
      );
      // Atomic audit: the ledger post and its review-log row commit together.
      await logAudit(
        {
          entityId,
          actionType: "post_transaction",
          objectTable: "bk_journal_entries",
          objectId: journalEntryId,
          description: "Posted a pending bank transaction to a category",
          affectedLedger: true,
        },
        tx
      );
      // Evidence ledger: was the pre-filled suggestion accepted or corrected?
      const decision = await recordSuggestionDecision(
        { txnId, postedAccountId: categoryAccountId, decidedBy: actor, kind: "posted" },
        tx
      );
      if (!row?.matchedRuleId) return { learning: undefined, decision };
      const out = await recordRuleOutcome({
        ruleId: row.matchedRuleId,
        entityId,
        chosenAccountId: categoryAccountId,
        absAmountCents: Math.abs(Number(row.amountCents)),
        journalEntryId,
        actor,
        tx,
      });
      return { learning: out.explanation || undefined, decision };
    });
    await afterSuggestionDecision(entityId, decision, categoryAccountId);
    revalidatePath(`/ledger/${entityId}/bank`);
    revalidatePath(`/ledger/${entityId}`);
    return { ok: true, learning };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Bulk-accept: post a set of still-pending transactions to their PERSISTED
 * suggestions (the "Accept all" / "Post selected" buttons on the tiered review
 * inbox). Server-side re-read of each suggestion — the client sends only txn
 * ids, so a stale browser can never post to an account the server no longer
 * suggests. Per-txn failures are isolated; learning is recorded per txn
 * exactly like a single post.
 */
export async function postSuggestedBulk(
  entityId: string,
  txnIds: string[]
): Promise<{ posted: number; skipped: number; errors: number }> {
  await assertEntityWrite(entityId);
  const actor = await actorEmail();
  const result = { posted: 0, skipped: 0, errors: 0 };
  const ids = [...new Set(txnIds)].slice(0, 200);
  for (const txnId of ids) {
    try {
      await assertTxnInEntity(txnId, entityId);
      const [t] = await db
        .select({
          status: schema.bkPlaidTransactions.status,
          pending: schema.bkPlaidTransactions.pending,
          suggestedAccountId: schema.bkPlaidTransactions.suggestedAccountId,
          suggestedPayee: schema.bkPlaidTransactions.suggestedPayee,
          matchedRuleId: schema.bkPlaidTransactions.matchedRuleId,
          amountCents: schema.bkPlaidTransactions.amountCents,
        })
        .from(schema.bkPlaidTransactions)
        .where(eq(schema.bkPlaidTransactions.id, txnId));
      if (
        !t ||
        t.status !== "pending_review" ||
        t.pending ||
        !t.suggestedAccountId
      ) {
        result.skipped++;
        continue;
      }
      const accountId = t.suggestedAccountId;
      const decision = await db.transaction(async (tx) => {
        const { journalEntryId } = await postPlaidTransaction(
          txnId,
          accountId,
          "plaid",
          t.suggestedPayee,
          tx
        );
        await logAudit(
          {
            entityId,
            actionType: "post_transaction",
            objectTable: "bk_journal_entries",
            objectId: journalEntryId,
            description: "Bulk-accepted a suggested categorization",
            affectedLedger: true,
          },
          tx
        );
        const d = await recordSuggestionDecision(
          { txnId, postedAccountId: accountId, decidedBy: actor, kind: "posted" },
          tx
        );
        if (t.matchedRuleId) {
          await recordRuleOutcome({
            ruleId: t.matchedRuleId,
            entityId,
            chosenAccountId: accountId,
            absAmountCents: Math.abs(Number(t.amountCents)),
            journalEntryId,
            actor,
            tx,
          });
        }
        return d;
      });
      await afterSuggestionDecision(entityId, decision, accountId);
      result.posted++;
    } catch (e) {
      result.errors++;
      console.error(`bulk accept: txn ${txnId} failed:`, e);
    }
  }
  revalidatePath(`/ledger/${entityId}/bank`);
  revalidatePath(`/ledger/${entityId}`);
  revalidatePath(`/review`);
  return result;
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
  await assertEntityWrite(entityId);
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
  await logAudit({
    entityId,
    actionType: "post_transaction_split",
    objectTable: "bk_plaid_transactions",
    objectId: txnId,
    description: `Posted a pending transaction as a ${lines.length}-line split entry`,
    affectedLedger: true,
  });
  revalidatePath(`/ledger/${entityId}/bank`);
  revalidatePath(`/ledger/${entityId}`);
  return { ok: true };
}

/** Drop a staged transaction from the review inbox without posting. */
export async function ignoreTransaction(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityWrite(entityId);
  const txnId = String(formData.get("txnId"));
  await assertTxnInEntity(txnId, entityId); // foreign txnId guard
  await ignorePlaidTransaction(txnId);
  // Evidence ledger: an ignore closes any open suggestion (not a correctness
  // signal — calibration excludes 'ignored').
  await recordSuggestionDecision({
    txnId,
    decidedBy: await actorEmail(),
    kind: "ignored",
  });
  await logAudit({
    entityId,
    actionType: "ignore_transaction",
    objectTable: "bk_plaid_transactions",
    objectId: txnId,
    description: "Ignored a pending bank transaction (removed from review)",
    affectedLedger: false,
  });
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
  await assertEntityWrite(entityId);
  const ignored = await suppressBookedNearMatches(entityId);
  if (ignored > 0) {
    await logAudit({
      entityId,
      actionType: "ignore_already_booked",
      objectTable: "bk_plaid_transactions",
      objectId: null,
      description: `Bulk-ignored ${ignored} already-booked near-match transactions`,
      affectedLedger: false,
    });
  }
  revalidatePath(`/ledger/${entityId}/bank`);
  return { ignored };
}

/** Reverse a posted transaction (undo) — returns it to the review inbox. */
export async function unpostTransaction(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  const entityId = String(formData.get("entityId"));
  await assertEntityWrite(entityId);
  const txnId = String(formData.get("txnId"));
  try {
    await assertTxnInEntity(txnId, entityId); // foreign txnId guard (this DELETES a journal entry)
    await unpostPlaidTransaction(txnId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // If this undid an AI AUTO-post, that's THE correction signal for its
  // calibration bucket: flip the event and lock the bucket immediately — one
  // wrong unattended post pulls automation trust on the spot.
  try {
    const reversal = await recordAutoPostReversal(txnId, await actorEmail());
    if (reversal.bucketKey) {
      await lockBucket(reversal.bucketKey, `auto-post undone (txn ${txnId})`);
    }
  } catch (e) {
    console.error("auto-post reversal recording failed:", e);
  }
  await logAudit({
    entityId,
    actionType: "unpost_transaction",
    objectTable: "bk_plaid_transactions",
    objectId: txnId,
    description: "Reversed a posted transaction (returned it to review)",
    affectedLedger: true,
  });
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
  await assertEntityWrite(entityId);
  const r = await autoPostEntity(entityId);
  if (r.posted > 0) {
    await logAudit({
      entityId,
      actionType: "auto_categorize",
      objectTable: "bk_journal_entries",
      objectId: null,
      description: `Ran deterministic auto-post: ${r.posted} transactions posted`,
      affectedLedger: true,
    });
  }
  revalidatePath(`/ledger/${entityId}/bank`);
  revalidatePath(`/ledger/${entityId}`);
  return { posted: r.posted, skippedDup: r.skippedDup, errors: r.errors };
}

/**
 * Suggest categories for the still-pending transactions (free history pre-pass
 * + Opus for the leftovers). Pre-fills the review dropdowns; writes nothing to
 * the ledger. OWNER-ONLY: this spends AI budget, so it is never available to
 * accountants/partners — they see whatever the nightly batch already persisted.
 */
export async function suggestCategoriesAction(
  entityId: string
): Promise<SuggestCategoriesResult> {
  await assertOwner();
  await assertEntityAccess(entityId); // 404 on an unknown entity id
  const rl = await limitAction("ai", await actionIdentity());
  if (rl) throw new Error(rl.error);
  return suggestCategories(entityId);
}

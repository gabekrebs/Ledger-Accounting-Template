import { NextRequest, NextResponse } from "next/server";
import {
  countPendingPortfolio,
  autoPostPortfolio,
  entitiesWithPending,
} from "@/lib/plaid/auto-post";
import { proposeRulesPortfolio } from "@/lib/rules/learner";
import {
  ingestCategoryBatches,
  submitCategoryBatch,
} from "@/lib/plaid/categorize-batch";
import { syncAllItems } from "@/lib/plaid/sync";
import { isAuthorizedCron } from "@/lib/security/machine-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

// Fire the portfolio sweep once outstanding review items cross this many.
// Automation-first: 1 means "run whenever anything is pending", so even a single
// low-volume account auto-posts on the daily sweep instead of waiting to pile up.
const TRIGGER_THRESHOLD = 1;

/**
 * Threshold-triggered categorization sweep. Every run, regardless of threshold,
 * it INGESTS any finished Batch-API jobs (results land async, across runs). Then,
 * when total pending-review transactions across all entities cross the trigger,
 * it (1) runs the deterministic auto-poster (Phase 1) over every entity —
 * posting unanimous-history matches with no AI and no human — and (2) submits the
 * remaining leftovers to the Batch API for Haiku suggestions (Phase 3b, 50% off),
 * persisting the free history suggestions inline. Suggestions only pre-fill the
 * review dropdowns; a human still posts.
 *
 * Below the threshold the submit/auto-post steps are skipped, so it's cheap to
 * schedule often. Triggered by Vercel Cron (GET + CRON_SECRET).
 */
export async function GET(request: NextRequest) {
  // Fail-closed: rejects everything when CRON_SECRET is unset/blank.
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Backstop the bank feed FIRST: drain every linked Plaid item. Link-time sync
  // races Plaid's async historical extraction (so a fresh link can pull nothing)
  // and the SYNC_UPDATES_AVAILABLE webhook can be missed or its Vercel after()
  // work cut short — either way the data sits in Plaid until something pulls it.
  // The Plaid webhook is the PRIMARY, real-time sync; this daily sweep is the
  // fallback/recovery pass that guarantees eventual consistency by catching up
  // whatever the webhook missed. Idempotent (cursor delta) and isolated so a
  // Plaid failure never blocks categorization.
  let sync: Awaited<ReturnType<typeof syncAllItems>> | { error: string };
  try {
    sync = await syncAllItems();
  } catch (e) {
    sync = { error: e instanceof Error ? e.message : String(e) };
  }

  // Pick up finished batches (cheap; no-op when none are open).
  const ingest = await ingestCategoryBatches();

  const outstanding = await countPendingPortfolio();
  if (outstanding < TRIGGER_THRESHOLD) {
    return NextResponse.json({
      ran: false,
      outstanding,
      threshold: TRIGGER_THRESHOLD,
      sync,
      ingest,
    });
  }

  const results = await autoPostPortfolio();
  const totals = results.reduce(
    (acc, r) => ({
      posted: acc.posted + r.posted,
      skippedDup: acc.skippedDup + r.skippedDup,
      errors: acc.errors + r.errors,
    }),
    { posted: 0, skippedDup: 0, errors: 0 }
  );

  // AUTHORS: propose rules from history for the swept entities (no posts, no AI
  // cost — the learner only writes PROPOSED rules a human approves). Idempotent.
  let learned: Awaited<ReturnType<typeof proposeRulesPortfolio>> = [];
  try {
    learned = await proposeRulesPortfolio(await entitiesWithPending());
  } catch (e) {
    console.error("learner sweep failed:", e);
  }
  // Fingerprint-retirement readiness: how many merchants the fingerprint would
  // auto-post, how many are already on an ACTIVE rule, and how many new proposals
  // the learner authored this run.
  const learnerTotals = learned.reduce(
    (a, l) => ({
      proposed: a.proposed + l.result.proposed,
      candidates: a.candidates + l.result.total,
      onActiveRules: a.onActiveRules + l.result.activeCovered,
    }),
    { proposed: 0, candidates: 0, onActiveRules: 0 }
  );

  // Submit one Batch-API job for the AI leftovers (skips if one's already open).
  const submit = await submitCategoryBatch();

  return NextResponse.json({
    ran: true,
    outstanding,
    threshold: TRIGGER_THRESHOLD,
    entities: results.length,
    ...totals,
    proposedRules: learnerTotals.proposed,
    fingerprintCandidates: learnerTotals.candidates,
    fingerprintOnActiveRules: learnerTotals.onActiveRules,
    remaining: await countPendingPortfolio(),
    sync,
    ingest,
    submit,
    results,
  });
}

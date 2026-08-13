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
import { enrichUnknownMerchants } from "@/lib/ai/merchant-intel";
import { recalibrateBuckets } from "@/lib/ai/calibration";
import { syncAllItems } from "@/lib/plaid/sync";
import { observeReconPortfolio } from "@/lib/ledger/recon-status";
import { isAuthorizedCron } from "@/lib/security/machine-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

// Fire the portfolio sweep once outstanding review items cross this many.
// Automation-first: 1 means "run whenever anything is pending", so even a single
// low-volume account auto-posts on the daily sweep instead of waiting to pile up.
const TRIGGER_THRESHOLD = 1;

/**
 * Threshold-triggered categorization sweep (ADR-021 pipeline order). Every run,
 * regardless of threshold, it INGESTS any finished Batch-API jobs and
 * RECALIBRATES the auto-post buckets from the evidence ledger. Then, when total
 * pending-review transactions cross the trigger, it:
 *   1. ENRICHES unknown merchants (one cached web lookup each, capped),
 *   2. runs the auto-poster over every entity — recognizers, auto-apply rules,
 *      and earned AI buckets,
 *   3. has the learner propose rules from booked history (human approves),
 *   4. submits the remaining leftovers to the Batch API for Opus suggestions
 *      (50% off), persisting the free history suggestions inline.
 * Suggestions only pre-fill the review UI; posting is a human click or an
 * earned bucket. Triggered by Vercel Cron (GET + CRON_SECRET).
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

  // Tick the Reconciliation settling clocks — an observation per Plaid-linked
  // entity so "off for N days" stays honest even through an unvisited week.
  // Timing vs the auto-post below is irrelevant (staged rows are netted out of
  // the residual either way). Isolated: a Plaid hiccup never blocks posting.
  let recon: Awaited<ReturnType<typeof observeReconPortfolio>> | { error: string };
  try {
    recon = await observeReconPortfolio();
  } catch (e) {
    recon = { error: e instanceof Error ? e.message : String(e) };
  }

  // Pick up finished batches (cheap; no-op when none are open).
  const ingest = await ingestCategoryBatches();

  // Recalibrate the auto-post buckets from the evidence ledger — measured
  // precision + the shadow→unlocked state machine. Cheap; runs every sweep so
  // yesterday's decisions count before today's auto-post pass.
  let calibration: Awaited<ReturnType<typeof recalibrateBuckets>> | { error: string };
  try {
    calibration = await recalibrateBuckets();
  } catch (e) {
    calibration = { error: e instanceof Error ? e.message : String(e) };
  }

  const outstanding = await countPendingPortfolio();
  if (outstanding < TRIGGER_THRESHOLD) {
    return NextResponse.json({
      ran: false,
      outstanding,
      threshold: TRIGGER_THRESHOLD,
      sync,
      recon,
      ingest,
      calibration,
    });
  }

  // Merchant intel BEFORE the batch submit, so a first-seen merchant's profile
  // is in the cache when its transactions reach the model. Isolated — an
  // enrichment failure never blocks posting.
  let intel: Awaited<ReturnType<typeof enrichUnknownMerchants>> | { error: string };
  try {
    intel = await enrichUnknownMerchants();
  } catch (e) {
    intel = { error: e instanceof Error ? e.message : String(e) };
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
    recon,
    ingest,
    calibration,
    intel,
    submit,
    results,
  });
}

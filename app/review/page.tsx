import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  accessibleEntityIds,
  entityAccessLevel,
  isAdmin,
  isEntityCreator,
} from "@/lib/ledger/access";
import {
  pendingCountsByEntity,
  buildEntityReviewData,
} from "@/lib/plaid/review-data";
import { ReviewList } from "@/app/ledger/[entityId]/bank/review-list";
import { HoldsSection, type HoldView } from "./holds-section";
import { db, schema } from "@/lib/db/client";
import { asc, inArray, isNull } from "drizzle-orm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Review Queue" };

/**
 * /review — the Review Queue: every settled-but-unposted transaction awaiting
 * categorization across ALL entities the signed-in user can access, in one
 * place, grouped by entity. Each section embeds the SAME ReviewList island the
 * per-entity Review tab uses, so categorize/post/split/ignore behave (and are
 * authorized) identically — every mutation re-asserts per-entity write on the
 * server. This page adds no new write surface; it only aggregates reads, and
 * those reads are scoped by `accessibleEntityIds` before any query runs.
 * Bank-PENDING (unsettled) transactions never appear here — they are not part
 * of the accounting workflow at all.
 */
export default async function ReviewQueuePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // THE authorization boundary for this page: everything below is filtered by
  // this set before any transaction is read.
  const ids = await accessibleEntityIds(user.email);
  const admin = await isAdmin(user.email);
  // AI spend stays with the owner alone — a future all-access admin still
  // reviews/posts but never triggers the model (the action re-asserts).
  const owner = isEntityCreator(user.email);

  // One indexed count query decides which entities need the full (heavier)
  // review assembly — entities with nothing pending are never deep-queried.
  // `excludeQueueHidden`: likely card-payment halves inside their auto-match
  // window don't count — they'd only be filtered out below anyway. The
  // unfiltered count runs alongside (indexed, cheap) purely to caption how
  // many rows are quieted, so the queue never silently disagrees with the
  // entity tabs.
  const [counts, countsAll] = await Promise.all([
    pendingCountsByEntity(ids, { settledOnly: true, excludeQueueHidden: true }),
    pendingCountsByEntity(ids, { settledOnly: true }),
  ]);
  const hiddenTotal =
    [...countsAll.values()].reduce((s, n) => s + n, 0) -
    [...counts.values()].reduce((s, n) => s + n, 0);
  const pendingEntityIds = [...counts.keys()];

  const entities = pendingEntityIds.length
    ? await db
        .select({
          id: schema.bkLedgerEntities.id,
          name: schema.bkLedgerEntities.name,
        })
        .from(schema.bkLedgerEntities)
        .where(inArray(schema.bkLedgerEntities.id, pendingEntityIds))
        .orderBy(asc(schema.bkLedgerEntities.name))
    : [];

  const sections = await Promise.all(
    entities.map(async (e) => {
      const [data, level] = await Promise.all([
        buildEntityReviewData(e.id),
        // Per-entity capability drives the UI: read-only users see the queue
        // but no write controls (the server actions re-assert this anyway).
        admin ? Promise.resolve("write" as const) : entityAccessLevel(user.email, e.id),
      ]);
      // Only settled transactions — an unsettled row can't post yet (post.ts
      // refuses it), so it doesn't belong in the accounting workflow. Queue-
      // hidden rows (fresh card-payment halves that will auto-match) are THIS
      // page's filter only — the entity Review tab shows them.
      return {
        entity: e,
        readOnly: level !== "write",
        data: {
          ...data,
          reviewRows: data.reviewRows.filter((r) => !r.txn.pending && !r.queueHidden),
        },
      };
    })
  );
  const nonEmpty = sections.filter((s) => s.data.reviewRows.length > 0);
  const total = nonEmpty.reduce((n, s) => n + s.data.reviewRows.length, 0);

  // ── Heads-up holds: every native entity the user can access (not just the
  // ones with pending rows — a hold is placed BEFORE the transaction lands),
  // plus all still-open holds. Scoped by the same authorization set. ──
  const holdEntities = (
    await db
      .select({
        id: schema.bkLedgerEntities.id,
        name: schema.bkLedgerEntities.name,
        nickname: schema.bkLedgerEntities.nickname,
      })
      .from(schema.bkLedgerEntities)
      .orderBy(asc(schema.bkLedgerEntities.name))
  ).filter((e) => ids === "all" || ids.has(e.id));
  const holdEntityLabel = new Map(holdEntities.map((e) => [e.id, e.nickname ?? e.name ?? "?"]));
  const openHolds: HoldView[] = holdEntities.length
    ? (
        await db
          .select()
          .from(schema.bkReviewHolds)
          .where(isNull(schema.bkReviewHolds.acknowledgedAt))
          .orderBy(asc(schema.bkReviewHolds.expiresAt))
      )
        .filter((h) => holdEntityLabel.has(h.entityId))
        .map((h) => ({
          id: h.id,
          entityLabel: holdEntityLabel.get(h.entityId)!,
          amountCents: h.amountCents,
          amountMaxCents: h.amountMaxCents,
          vendorText: h.vendorText,
          note: h.note,
          expiresAt: h.expiresAt.toISOString(),
          matchCount: h.matchCount,
          lastMatchedAt: h.lastMatchedAt ? h.lastMatchedAt.toISOString() : null,
        }))
    : [];

  return (
    <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">
      <div className="mx-auto w-full max-w-page space-y-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link
              href="/"
              className="text-xs text-faint transition-colors hover:text-evergreen"
            >
              ← All entities
            </Link>
            <h1 className="mt-1 font-serif text-2xl font-medium tracking-tight">
              Review Queue
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Bank-settled transactions ready to post to the ledger, across
              all your entities.
            </p>
            {hiddenTotal > 0 && (
              <p className="mt-1 text-xs text-faint">
                {hiddenTotal} credit-card{" "}
                {hiddenTotal === 1 ? "payment is" : "payments are"} waiting to
                auto-match and hidden for a few days — still visible on each
                entity&apos;s Review tab.
              </p>
            )}
          </div>
          {total > 0 && (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
              {total} ready to post across {nonEmpty.length}{" "}
              {nonEmpty.length === 1 ? "entity" : "entities"}
            </span>
          )}
        </div>

        <HoldsSection
          entities={holdEntities.map((e) => ({ id: e.id, label: holdEntityLabel.get(e.id)! }))}
          holds={openHolds}
          nowIso={new Date().toISOString()}
        />

        {nonEmpty.length === 0 ? (
          <div className="rounded-xl border border-dashed border-hair px-6 py-16 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-evergreen/8 text-evergreen">
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <p className="mt-3 text-sm font-medium">All caught up</p>
            <p className="mt-1 text-xs text-faint">
              No transactions are waiting for review in any entity you can
              access. New bank activity lands here after each sync.
            </p>
          </div>
        ) : (
          <div className="space-y-10">
            {nonEmpty.map(({ entity, readOnly, data }) => (
              <section key={entity.id} className="space-y-3">
                <div className="flex items-baseline justify-between gap-3 border-b border-hair pb-2">
                  <h2 className="font-serif text-lg font-medium tracking-tight">
                    <Link
                      href={`/ledger/${entity.id}/bank`}
                      prefetch={false}
                      className="transition-colors hover:text-evergreen"
                    >
                      {entity.name}
                    </Link>
                    <span className="ml-2 align-middle rounded-full border border-hair px-2 py-0.5 text-[11px] font-sans font-medium text-muted-foreground">
                      {data.reviewRows.length}
                    </span>
                  </h2>
                  <Link
                    href={`/ledger/${entity.id}/bank`}
                    prefetch={false}
                    className="shrink-0 text-xs text-faint transition-colors hover:text-evergreen"
                  >
                    Open entity review →
                  </Link>
                </div>
                <ReviewList
                  entityId={entity.id}
                  rows={data.reviewRows}
                  accounts={data.postableOpts}
                  pendingLabel={`${data.reviewRows.length} ready to post`}
                  initialSuggestions={data.initialSuggestions}
                  knownPayees={data.knownPayees}
                  readOnly={readOnly}
                  canRunAi={owner}
                />
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

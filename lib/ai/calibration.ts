import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

/**
 * Calibration (ADR-021) — turn the evidence ledger into MEASURED confidence.
 *
 * The model's self-reported % is not trustworthy; observed precision is. The
 * nightly sweep aggregates decided suggestions per bucket ("ai|seen|b90") into
 * bk_autopost_buckets:
 *   • measured_precision = accepted / (accepted + corrected) — ignores 'ignored'
 *     (an ignore says "not postable", not "wrong category").
 *   • the UI shows measured_precision as the calibrated % once a bucket has
 *     CALIBRATED_MIN_OUTCOMES; below that it shows the raw % tagged "unproven".
 *   • the auto-post state machine: shadow → unlocked at ≥ UNLOCK_MIN_PRECISION
 *     over ≥ UNLOCK_MIN_OUTCOMES; ONE correction locks (synchronously, in the
 *     decision path); a locked bucket re-earns unlock only with a clean streak
 *     after the lock.
 */

const { bkCategorizationEvents, bkAutopostBuckets } = schema;

export const CALIBRATED_MIN_OUTCOMES = 30;
export const UNLOCK_MIN_OUTCOMES = 50;
export const UNLOCK_MIN_PRECISION = 0.98;
/** clean decisions required after a lock before a bucket may re-unlock */
export const RELOCK_RECOVERY_OUTCOMES = 10;

export interface BucketStat {
  bucketKey: string;
  status: string;
  outcomes: number;
  correct: number;
  measuredPrecision: number | null;
  unlockedAt: Date | null;
  lockedAt: Date | null;
  lockReason: string | null;
}

/** One correction kills the trust — called synchronously from decision paths. */
export async function lockBucket(
  bucketKey: string,
  reason: string
): Promise<void> {
  await db
    .insert(bkAutopostBuckets)
    .values({
      bucketKey,
      status: "locked",
      lockedAt: new Date(),
      lockReason: reason,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: bkAutopostBuckets.bucketKey,
      set: {
        status: "locked",
        lockedAt: new Date(),
        lockReason: reason,
        updatedAt: new Date(),
      },
    });
}

/**
 * Recompute every bucket's counts + precision from the evidence ledger and run
 * the unlock state machine. Idempotent; the cron runs it daily.
 */
export async function recalibrateBuckets(): Promise<{
  buckets: number;
  unlocked: number;
}> {
  // Correctness signal only: accepted (right) vs corrected (wrong). An
  // auto_posted row is a *pending* accept — it becomes 'corrected' only if
  // undone — so it counts as correct here, which is exactly the behavior we
  // want measured (an un-reversed auto-post IS a success).
  const rows = (await db.execute(sql`
    select bucket_key,
           count(*) filter (where outcome in ('accepted','corrected','auto_posted'))::int as outcomes,
           count(*) filter (where outcome in ('accepted','auto_posted'))::int as correct
    from bk_categorization_events
    where bucket_key is not null
      and outcome in ('accepted','corrected','auto_posted')
    group by bucket_key
  `)) as unknown as Array<{
    bucket_key: string;
    outcomes: number;
    correct: number;
  }>;

  let unlockedCount = 0;
  for (const r of rows) {
    const precision = r.outcomes > 0 ? r.correct / r.outcomes : null;
    await db
      .insert(bkAutopostBuckets)
      .values({
        bucketKey: r.bucket_key,
        outcomes: r.outcomes,
        correct: r.correct,
        measuredPrecision: precision,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: bkAutopostBuckets.bucketKey,
        set: {
          outcomes: r.outcomes,
          correct: r.correct,
          measuredPrecision: precision,
          updatedAt: new Date(),
        },
      });

    // State machine. Only AI buckets ever unlock — history suggestions
    // graduate through the rules learner instead, and only the top band with
    // the merchant already seen in the books is auto-post material.
    const eligible = r.bucket_key.startsWith("ai|seen|b9");
    if (!eligible || precision === null) continue;

    const [bucket] = await db
      .select()
      .from(bkAutopostBuckets)
      .where(eq(bkAutopostBuckets.bucketKey, r.bucket_key));
    if (!bucket) continue;

    if (
      bucket.status === "shadow" &&
      r.outcomes >= UNLOCK_MIN_OUTCOMES &&
      precision >= UNLOCK_MIN_PRECISION
    ) {
      await db
        .update(bkAutopostBuckets)
        .set({ status: "unlocked", unlockedAt: new Date(), updatedAt: new Date() })
        .where(eq(bkAutopostBuckets.bucketKey, r.bucket_key));
      unlockedCount++;
    } else if (bucket.status === "locked" && bucket.lockedAt) {
      // Recovery: a clean streak since the lock (no corrections at all) plus
      // the overall bar re-earns the unlock.
      const [since] = await db
        .select({
          n: sql<number>`count(*) filter (where outcome in ('accepted','auto_posted'))::int`,
          bad: sql<number>`count(*) filter (where outcome = 'corrected')::int`,
        })
        .from(bkCategorizationEvents)
        .where(
          and(
            eq(bkCategorizationEvents.bucketKey, r.bucket_key),
            isNotNull(bkCategorizationEvents.decidedAt),
            gt(bkCategorizationEvents.decidedAt, bucket.lockedAt)
          )
        );
      if (
        (since?.bad ?? 1) === 0 &&
        (since?.n ?? 0) >= RELOCK_RECOVERY_OUTCOMES &&
        precision >= UNLOCK_MIN_PRECISION
      ) {
        await db
          .update(bkAutopostBuckets)
          .set({
            status: "unlocked",
            unlockedAt: new Date(),
            lockReason: null,
            updatedAt: new Date(),
          })
          .where(eq(bkAutopostBuckets.bucketKey, r.bucket_key));
        unlockedCount++;
      }
    }
  }
  return { buckets: rows.length, unlocked: unlockedCount };
}

/** Bucket stats for a set of keys — the UI's calibrated-% lookup. */
export async function readBucketStats(
  bucketKeys: string[]
): Promise<Map<string, BucketStat>> {
  const uniq = [...new Set(bucketKeys.filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = await db
    .select()
    .from(bkAutopostBuckets)
    .where(inArray(bkAutopostBuckets.bucketKey, uniq));
  return new Map(
    rows.map((r) => [
      r.bucketKey,
      {
        bucketKey: r.bucketKey,
        status: r.status,
        outcomes: r.outcomes,
        correct: r.correct,
        measuredPrecision: r.measuredPrecision,
        unlockedAt: r.unlockedAt,
        lockedAt: r.lockedAt,
        lockReason: r.lockReason,
      },
    ])
  );
}

/** Every bucket, for the automation panel on the global rules page. */
export async function listBuckets(): Promise<BucketStat[]> {
  const rows = await db
    .select()
    .from(bkAutopostBuckets)
    .orderBy(bkAutopostBuckets.bucketKey);
  return rows.map((r) => ({
    bucketKey: r.bucketKey,
    status: r.status,
    outcomes: r.outcomes,
    correct: r.correct,
    measuredPrecision: r.measuredPrecision,
    unlockedAt: r.unlockedAt,
    lockedAt: r.lockedAt,
    lockReason: r.lockReason,
  }));
}


/**
 * The display confidence for a suggestion: the bucket's measured precision once
 * it has enough outcomes, else the raw model/history number tagged unproven.
 */
export function calibratedDisplay(
  raw: number,
  stat: BucketStat | undefined
): { confidence: number; calibrated: boolean } {
  if (stat && stat.outcomes >= CALIBRATED_MIN_OUTCOMES && stat.measuredPrecision != null) {
    return { confidence: stat.measuredPrecision, calibrated: true };
  }
  return { confidence: raw, calibrated: false };
}

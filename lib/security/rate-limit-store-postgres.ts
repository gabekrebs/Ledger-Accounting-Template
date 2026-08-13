import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { HitResult, RateLimitStore } from "@/lib/security/rate-limit-store";

/**
 * Durable, cross-instance rate-limit store backed by the existing Supabase
 * Postgres (`bk_rate_limits`). Enabled only via RATE_LIMIT_BACKEND=postgres AND
 * after `scripts/add-rate-limits.mjs` has created the table — until then, any
 * query errors and the caller fails OPEN, so a missing table can never lock
 * anyone out.
 *
 * The count is a SINGLE atomic upsert (INSERT … ON CONFLICT DO UPDATE …
 * RETURNING), which is safe under concurrent requests — Postgres serializes the
 * conflicting update with a row lock, so no increments are lost. No read-then-
 * write race.
 *
 * Rows self-expire by window; expired rows are pruned opportunistically (a
 * cheap indexed DELETE on a small fraction of writes) so the table stays bounded
 * without any cron dependency.
 */
export class PostgresStore implements RateLimitStore {
  async hit(key: string, windowMs: number): Promise<HitResult> {
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const resetAt = new Date((bucket + 1) * windowMs);

    const rows = (await db.execute(sql`
      INSERT INTO bk_rate_limits (key, window_start, count, reset_at)
      VALUES (${key}, ${bucket}, 1, ${resetAt.toISOString()})
      ON CONFLICT (key, window_start)
      DO UPDATE SET count = bk_rate_limits.count + 1
      RETURNING count, reset_at
    `)) as unknown as Array<{ count: number | string; reset_at: string | Date }>;

    const r = rows[0];
    void this.maybePrune(now);
    return {
      count: Number(r.count),
      resetAt: new Date(r.reset_at).getTime(),
    };
  }

  /** ~1% of writes: delete windows that have already reset. Best-effort. */
  private async maybePrune(now: number): Promise<void> {
    if (Math.random() > 0.01) return;
    try {
      await db.execute(
        sql`DELETE FROM bk_rate_limits WHERE reset_at < ${new Date(now).toISOString()}`
      );
    } catch {
      // Pruning is best-effort; never surface an error to the caller.
    }
  }
}

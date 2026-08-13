/**
 * Rate-limit storage abstraction. Fixed-window counters: the caller passes a
 * hashed key, the window length, and the limit; the store returns the current
 * count for the active window and when it resets.
 *
 * Two implementations:
 *  - MemoryStore (here)          — per-instance, bounded, DEFAULT. Temporary
 *                                  defense in depth; NOT authoritative across
 *                                  Vercel's ephemeral instances.
 *  - PostgresStore (separate)    — durable, cross-instance, opt-in via migration.
 */
export interface HitResult {
  /** Count within the current window AFTER this hit. */
  count: number;
  /** Epoch ms when the current window ends. */
  resetAt: number;
}

export interface RateLimitStore {
  /** Record one hit in the current window for `key`; return the running count. */
  hit(key: string, windowMs: number): Promise<HitResult>;
}

/**
 * Bounded in-process fixed-window store. Memory is capped two ways: a periodic
 * sweep drops expired windows, and if the map still exceeds MAX_ENTRIES the
 * oldest keys are evicted. So it can never grow without bound, even under a key
 * flood — the worst case is that some counters are evicted early (fail-open,
 * acceptable for a best-effort per-instance limiter).
 */
export class MemoryStore implements RateLimitStore {
  private readonly map = new Map<string, HitResult>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private lastSweep = 0;

  /** `now` is injectable so tests can advance time deterministically. */
  constructor(maxEntries = 10_000, now: () => number = () => Date.now()) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  async hit(key: string, windowMs: number): Promise<HitResult> {
    const now = this.now();
    // Bucket by window so a stale window is naturally a different key.
    const bucket = Math.floor(now / windowMs);
    const k = `${key}:${bucket}`;

    let e = this.map.get(k);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: (bucket + 1) * windowMs };
    }
    e.count += 1;
    this.map.set(k, e);

    this.maybeSweep(now);
    return { count: e.count, resetAt: e.resetAt };
  }

  /** Drop expired windows periodically; hard-cap size by evicting oldest. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep > 30_000 || this.map.size > this.maxEntries) {
      this.lastSweep = now;
      for (const [k, e] of this.map) {
        if (e.resetAt <= now) this.map.delete(k);
      }
      if (this.map.size > this.maxEntries) {
        // Map preserves insertion order — evict the oldest surplus keys.
        let excess = this.map.size - this.maxEntries;
        for (const k of this.map.keys()) {
          if (excess-- <= 0) break;
          this.map.delete(k);
        }
      }
    }
  }

  /** Test-only introspection: current number of tracked windows. */
  size(): number {
    return this.map.size;
  }
}

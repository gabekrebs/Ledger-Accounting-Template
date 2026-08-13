/** Format integer cents as USD. Negative shown in parentheses (accounting). */
export function usd(cents: number, opts: { paren?: boolean } = {}): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = (abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (neg) return opts.paren ? `($${s})` : `-$${s}`;
  return `$${s}`;
}

/** Compact USD for inline provenance notes: $2.76M, $940K, $512. */
export function usdCompact(cents: number): string {
  const dollars = Math.round(cents / 100);
  const abs = Math.abs(dollars);
  const sign = dollars < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${abs}`;
}

/** "2026-04-22" → "Apr 22, 2026" without tripping over timezones. */
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11) return iso;
  return `${MONTHS[mi]} ${Number(d)}, ${y}`;
}

/** Plain USD for model prompts / logs — "$1,234.56", no accounting negatives. */
export function usdPlain(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/** "+12.3%" / "−4.5%" vs a prior value; null when prior is 0 (undefined %). */
export function variancePct(cur: number, prior: number): string | null {
  if (prior === 0) return null;
  const pct = ((cur - prior) / Math.abs(prior)) * 100;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
}

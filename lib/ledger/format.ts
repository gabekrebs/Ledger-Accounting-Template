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

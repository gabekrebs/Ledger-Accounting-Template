/** Shared FormData coercions for the entity admin forms (loans, documents,
 * valuation). One home so "empty string means null" stays one rule. */

export function str(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

export function floatOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** "$1,234.56" -> 123456 integer cents (null when blank/unparseable). */
export function dollarsToCents(v: FormDataEntryValue | null): number | null {
  const raw = String(v ?? "").replace(/[$,]/g, "").trim();
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

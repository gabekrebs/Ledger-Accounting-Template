/**
 * Merchant / payee text normalization — PURE (no db). The shared vocabulary for
 * keying a bank descriptor to a stable merchant identity, used by the statistical
 * fingerprint, the rules engine's facts, the history→rule learner, and the P&L
 * drill-down. Kept in one neutral module so nothing depends on any single
 * consumer (in particular, the rules engine must not import the legacy
 * fingerprint file).
 *
 * Two jobs:
 *   • extractParty — recover the originating party from a raw NACHA/Zelle/ACH
 *     descriptor (or pass a clean name through).
 *   • normalizeMerchant / candidateKeys — collapse a payee to a stable key, and
 *     enumerate the candidate keys for a transaction (clean name, party from the
 *     descriptor, rebrand bridges) strongest-first.
 */

// ── extractParty ─────────────────────────────────────────────────────────────

const collapseWs = (s: string) => s.replace(/\s+/g, " ").trim();
function tidyParty(s: string): string | null {
  const out = collapseWs(s).replace(/[\s",;:]+$/, "").trim();
  return out || null;
}

/**
 * The originating party for a transaction: a clean `name` if present, else the
 * party parsed out of a raw bank descriptor (Zelle/Venmo P2P, or the NACHA/ACH
 * company name before " DES:"). Null when nothing usable is found.
 */
export function extractParty(e: {
  name?: string | null;
  lineMemo?: string | null;
  memo?: string | null;
}): string | null {
  const name = e.name?.trim();
  if (name) return name;
  const raw = collapseWs(e.lineMemo || e.memo || "");
  if (!raw) return null;

  // Zelle / Venmo person-to-person: "...payment from <NAME> for ..." or "... Conf# ..."
  const p2p = raw.match(/payment\s+(?:from|to)\s+(.+?)\s*(?:\bfor\b|conf#|$)/i);
  if (p2p?.[1]) return tidyParty(p2p[1]);

  // NACHA/ACH: the originating company name precedes " DES:". Drop a trailing
  // merchant reference number ("AIRBNB 4977" → "AIRBNB").
  const ach = raw.match(/^(.+?)\s+DES:/);
  if (ach?.[1]) return tidyParty(ach[1].replace(/\s+\d{2,}$/, ""));

  return null;
}

// ── normalizeMerchant ────────────────────────────────────────────────────────

/**
 * Token-level spelling variants folded to one canonical form so the same biller
 * keys identically no matter which side abbreviated. Bank NACHA descriptors and
 * imported books routinely disagree on exactly these ("NW Natural" in the books
 * vs "NORTHWEST NATURA…" from Plaid; "CTY PORTLAND" vs "City of Portland") and
 * no prefix-fuzzy match can bridge a different FIRST word. Abbreviations are
 * EXPANDED (nw → northwest), never contracted: longer keys keep a Plaid-
 * truncated descriptor's key above the fuzzy matcher's min-length guard.
 * Universal English/banking facts only — no entity- or merchant-specific data.
 */
const TOKEN_CANON: Record<string, string> = {
  nw: "northwest",
  ne: "northeast",
  sw: "southwest",
  se: "southeast",
  cty: "city",
};
/** Filler words dropped from keys ("City of Portland" ↔ "CTY PORTLAND"). */
const STOP_TOKENS = new Set(["of", "the"]);

/**
 * Collapse a payee string to a stable key: lowercase, drop digits (store #s,
 * location codes, dates baked into the descriptor) and punctuation, collapse
 * whitespace, then canonicalize per-token (compass contractions, drop "of"/
 * "the"). Over-merging only ever lowers confidence (more candidate categories),
 * it can't force a wrong auto-post because the agreement gate still has to hold.
 */
export function normalizeMerchant(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ") // strips digits + punctuation
    .split(/\s+/)
    .filter((t) => t && !STOP_TOKENS.has(t))
    .map((t) => TOKEN_CANON[t] ?? t)
    .join(" ")
    .trim();
}

// ── candidateKeys ────────────────────────────────────────────────────────────

/** normalized new brand (prefix) → normalized predecessor it bills as. */
const REBRANDS: [string, string][] = [
  ["quantum fiber", "centurylink"], // CenturyLink's consumer-fiber rebrand (Lumen)
];

/**
 * Candidate normalized keys for a transaction, strongest first: the cleaned
 * `merchant_name`, then the party extracted from the raw bank descriptor (the
 * NACHA string the imported history's memos carry too — extracting the
 * originator from each makes the two sides meet on an identical key), then the
 * raw descriptor itself. A corporate-rebrand bridge is appended LAST so a
 * merchant's own direct history always wins over the rebrand.
 */
export function candidateKeys(...raws: (string | null | undefined)[]): string[] {
  const keys: string[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    for (const k of [
      normalizeMerchant(raw),
      normalizeMerchant(extractParty({ memo: raw })),
    ]) {
      if (k.length >= 3 && !keys.includes(k)) keys.push(k);
    }
  }
  for (const [brand, formerly] of REBRANDS) {
    if (keys.some((k) => k.startsWith(brand)) && !keys.includes(formerly)) {
      keys.push(formerly);
    }
  }
  return keys;
}

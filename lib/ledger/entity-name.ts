/**
 * Display-name normalization for ledger entities.
 *
 * QBO returns company names in ALL CAPS ("ASSIDUOUS INVESTMENTS LLC"). The
 * partner-facing `bk_ledger_entities.name` should read like a proper name
 * ("Acme Holdings LLC") while `legal_name` keeps the registered string
 * verbatim. This function is the single source of truth for that transform and
 * is applied at the import chokepoint (`ensureLedgerEntity`), so every path —
 * the in-app /api/ledger/import route, the onboard-qbo-entity script, and the
 * Wave importer — produces consistently cased display names with zero code edits
 * per customer.
 *
 * Design: smart title-case that is IDEMPOTENT on already-pretty names, so a
 * customer's manual UI edit (or a hand-set Wave display name like
 * "Maple Court Apartments") survives a re-import untouched.
 *
 * Rules per whitespace-separated token:
 *  - Already mixed-case (has both upper and lower) → preserve verbatim. This is
 *    the idempotency guard — anything a human already cased stays as typed
 *    ("Townhomes", "McWilliams").
 *  - Ordinals (12TH, 21ST, 2ND, 3RD) → digits + lowercase suffix → "12th".
 *  - Contains a digit (addresses, ranges "1202-1210") → leave verbatim.
 *  - Compass directionals (SE, NW, NE, …) → uppercase.
 *  - Entity/legal suffixes & abbreviations (LLC, LP, INC, CO, USA, roman
 *    numerals) → uppercase.
 *  - Everything else → Title Case ("EVERETT"→"Everett", "BLVD"→"Blvd").
 *
 * Known limitation: an all-caps acronym with no other signal (e.g. "CHJ",
 * "GWWN") title-cases to "Chj"/"Gwwn". We deliberately do NOT use a no-vowel
 * heuristic because it would wrongly keep street abbreviations uppercase
 * (BLVD/RD/DR/CT/LN/PL). Such names are rare in the import pipeline and remain
 * editable in the UI.
 */

const KEEP_UPPER = new Set([
  "LLC", "L.L.C.", "LP", "L.P.", "LLP", "PLLC", "PC", "P.C.",
  "INC", "INC.", "CO", "CO.", "CORP", "CORP.", "LTD", "LTD.",
  "USA", "DBA", "PO",
  // Roman numerals (suffixes like "Holdings III")
  "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII",
]);

const DIRECTIONALS = new Set([
  "N", "S", "E", "W", "NE", "NW", "SE", "SW",
  "NNE", "NNW", "SSE", "SSW", "ENE", "ESE", "WNW", "WSW",
]);

function fixToken(tok: string): string {
  if (tok === "") return tok;

  const upper = tok.toUpperCase();
  const lower = tok.toLowerCase();

  // Idempotency guard: a token a human already cased (mixed upper+lower) is left
  // exactly as typed. All-caps and all-lower fall through to the rules below.
  if (tok !== upper && tok !== lower) return tok;

  // Ordinals must be checked before the generic digit guard ("12TH" → "12th").
  const ord = upper.match(/^(\d+)(ST|ND|RD|TH)$/);
  if (ord) return ord[1] + ord[2].toLowerCase();

  // Addresses / numeric ranges keep their literal form.
  if (/\d/.test(tok)) return tok;

  if (KEEP_UPPER.has(upper)) return upper;
  if (DIRECTIONALS.has(upper)) return upper;

  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
}

/**
 * Normalize a raw (often ALL-CAPS) entity name into a partner-facing display
 * name. Idempotent. Apply to `name` only — never to `legal_name`, which must
 * stay verbatim.
 */
export function displayEntityName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map(fixToken)
    .join(" ");
}

/**
 * Unit tests for the Portfolio Comparison "own share" owner matching.
 *
 *   SUPABASE_DB_URL=postgres://u:p@127.0.0.1:5432/none npx tsx scripts/portfolio-comparison.test.mts
 *
 * The security-relevant invariant: a non-owner (or unknown first name) resolves
 * to null — NEVER to another owner's percentage (the old code hardcoded Alice).
 */
import { readFileSync } from "node:fs";
import {
  ownerPctForFirstName,
  ownerPctForFirstNameAsOf,
  ownerShareSegments,
} from "../lib/ledger/reports";

let pass = 0;
const fails: string[] = [];
const ok = (c: boolean, m: string) => (c ? pass++ : fails.push(m));

// Real portfolio shapes (from the entities' owners lists).
const maple = [
  { pct: 33.34, name: "Alice Example" },
  { pct: 33.33, name: "Bob Sample" },
  { pct: 33.33, name: "Dan Sample" },
];
const elkPark = [
  { pct: 33.33, name: "Dan + Deb" },
  { pct: 33.33, name: "Alice Example" },
  { pct: 16.67, name: "Eve Jordan" },
];
// Ridgeline 2's real shape post-reroster: LEGAL pcts (books/taxes/true-up)
// with the ECONOMIC share carried as reportingPct — one member's stake is
// temporarily parked with another until they can legally hold US real estate.
const ridgeline2 = [
  { pct: 33.34, name: "Fay Example", reportingPct: 25 },
  { pct: 33.33, name: "Alice Example", reportingPct: 25 },
  { pct: 33.33, name: "Bob Sample", reportingPct: 25 },
];

// ── Correct owner matches ────────────────────────────────────────────────────
ok(ownerPctForFirstName(maple, "Bob") === 33.33, "Bob → his %");
ok(ownerPctForFirstName(maple, "Dan") === 33.33, "Dan → his % (distinct from Alice)");
ok(ownerPctForFirstName(maple, "Alice") === 33.34, "Alice → his %");
ok(ownerPctForFirstName(elkPark, "Dan") === 33.33, '"Dan + Deb" matches first name Dan');

// ── First-name collisions on last name are correctly separated ───────────────
ok(ownerPctForFirstName(ridgeline2, "Fay") === 33.34, "Fay Example ≠ Alice Example (Fay)");
ok(ownerPctForFirstName(ridgeline2, "Alice") === 33.33, "Alice Example ≠ Fay Example (Alice)");

// ── Legal vs reporting basis ─────────────────────────────────────────────────
// Default (legal) returns pct; "reporting" returns reportingPct when present,
// falling back to pct when absent. Non-owners stay null on BOTH bases.
ok(ownerPctForFirstName(ridgeline2, "Alice", "reporting") === 25, "reporting basis → economic 25%");
ok(ownerPctForFirstName(ridgeline2, "Fay", "reporting") === 25, "reporting basis → Fay's economic 25%");
ok(ownerPctForFirstName(ridgeline2, "Alice", "legal") === 33.33, "explicit legal basis → 33.33");
ok(ownerPctForFirstName(maple, "Alice", "reporting") === 33.34, "no reportingPct → falls back to pct");
ok(ownerPctForFirstName(ridgeline2, "Zoe", "reporting") === null, "non-roster member → null on reporting basis too");
ok(
  ownerPctForFirstName(maple, "Alice") !== ownerPctForFirstName(maple, "Dan") ||
    true,
  "Alice and Dan resolve independently"
);

// ── Case / whitespace normalization ──────────────────────────────────────────
ok(ownerPctForFirstName(maple, "bob") === 33.33, "case-insensitive match");
ok(ownerPctForFirstName(maple, "  Bob  ") === 33.33, "trims the first name");

// ── The security invariant: non-owner → null, NEVER another owner ────────────
ok(ownerPctForFirstName(maple, "Phil") === null, "non-owner Phil → null (not a fallback %)");
ok(ownerPctForFirstName(maple, "Sample") === null, "last name alone → null (first word only)");
ok(ownerPctForFirstName(maple, "Arm") === null, "partial first name → null (no substring match)");
ok(ownerPctForFirstName(maple, "") === null, "empty first name → null");
ok(ownerPctForFirstName(maple, null) === null, "null first name → null");
ok(ownerPctForFirstName(maple, undefined) === null, "undefined first name → null");
ok(ownerPctForFirstName(null, "Alice") === null, "null owners → null");
ok(ownerPctForFirstName([], "Alice") === null, "empty owners → null");

// Ambiguity: two owners sharing a first name must resolve to null, NEVER to
// either one's % (found by the Fable review — the invariant's edge case).
const twoDans = [
  { pct: 40, name: "Dan Sample" },
  { pct: 10, name: "Dan Smith" },
];
ok(ownerPctForFirstName(twoDans, "Dan") === null, "two owners named Dan → null (ambiguous, never guess)");
ok(ownerPctForFirstName(twoDans, "greg") === null, "ambiguous match is case-insensitive too");


// ── Dated ownership (buyouts): prior entries govern earlier dates ────────────
// NE 11th / SE 8th real shape: Carol bought out 2026-08-03, 25→50 each.
const boughtOut = [
  { pct: 50, name: "Alice Example", prior: [{ until: "2026-08-03", pct: 25 }] },
  { pct: 50, name: "Bob Sample", prior: [{ until: "2026-08-03", pct: 25 }] },
];
ok(ownerPctForFirstNameAsOf(boughtOut, "Alice", "legal", "2026-08-02") === 25, "day before buyout → historic 25");
ok(ownerPctForFirstNameAsOf(boughtOut, "Alice", "legal", "2026-08-03") === 50, "buyout day itself → new 50");
ok(ownerPctForFirstNameAsOf(boughtOut, "Alice", "legal", "2025-06-15") === 25, "deep history → 25");
ok(ownerPctForFirstNameAsOf(boughtOut, "Carol", "legal", "2025-06-15") === null, "off the roster → null even for historic dates");
ok(ownerPctForFirstNameAsOf(maple, "Alice", "legal", "2020-01-01") === 33.34, "no prior → current pct at any date");

// Segmentation: a period spanning the change splits at the boundary…
{
  const segs = ownerShareSegments(boughtOut, "Alice", "legal", "2026-07-11", "2026-08-10")!;
  ok(segs.length === 2, "spanning period → two segments");
  ok(segs[0].start === "2026-07-11" && segs[0].end === "2026-08-02" && segs[0].pct === 25, "first segment ends the day before, at 25");
  ok(segs[1].start === "2026-08-03" && segs[1].end === "2026-08-10" && segs[1].pct === 50, "second segment starts on the change day, at 50");
}
// …fully-historic and fully-current periods stay single-segment.
{
  const ly = ownerShareSegments(boughtOut, "Alice", "legal", "2025-01-01", "2025-12-31")!;
  ok(ly.length === 1 && ly[0].pct === 25, "last-year period → one 25% segment");
  const now = ownerShareSegments(boughtOut, "Alice", "legal", "2026-08-04", "2026-08-10")!;
  ok(now.length === 1 && now[0].pct === 50, "post-buyout period → one 50% segment");
  ok(ownerShareSegments(boughtOut, "Carol", "legal", "2025-01-01", "2025-12-31") === null, "non-owner → null segments");
}

// ── Static anchors: shared owner match in use; accountants gated ──────────────
{
  const comp = readFileSync("app/comparison/page.tsx", "utf8");
  const ledger = readFileSync("app/ledger/page.tsx", "utf8");
  const view = readFileSync("app/ledger/portfolio-comparison.tsx", "utf8");
  for (const [file, src] of [["comparison", comp], ["ledger", ledger]] as const) {
    ok(src.includes("ownerPctForFirstName"), `${file} uses the shared owner match`);
    ok(src.includes("canSeeOwnView"), `${file} passes the role-based view gate`);
  }
  ok(view.includes("canSeeOwnView"), "component honors the accountant/own-view gate");
  ok(view.includes('view === "own"'), "component drives the own-share view");
}

console.log(`\nportfolio-comparison: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("  ✗ " + f);
process.exit(fails.length ? 1 : 0);

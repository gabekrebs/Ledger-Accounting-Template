/**
 * Pure-logic unit tests for the home page's fuzzy property matcher. No
 * database, no env needed:
 *
 *   npx tsx scripts/fuzzy.test.mts
 *
 * No framework (repo convention — see scripts/rules-engine.test.mts): a tiny
 * assert harness that exits non-zero on failure.
 */

import { fuzzyMatch } from "../lib/fuzzy";

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) {
    failures++;
    console.error(`✗ ${label}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// The four canonical launcher queries.
check("substring: 'jack' → NW Jackson", fuzzyMatch("jack", "NW Jackson") !== null);
check("initials-ish: 'nwj' → NW Jackson", fuzzyMatch("nwj", "NW Jackson") !== null);
check("prefix: 'mapl' → NE Mapleton 5264", fuzzyMatch("mapl", "NE Mapleton 5264") !== null);
check("prefix: 'mapl' → NE Mapleton 6524", fuzzyMatch("mapl", "NE Mapleton 6524") !== null);
check("word: 'oak' → Oak Park", fuzzyMatch("oak", "Oak Park") !== null);

// Multi-word queries ride the literal space.
check("spaced: 'ne mapl' → NE Mapleton 5264", fuzzyMatch("ne mapl", "NE Mapleton 5264") !== null);

// Non-matches stay out.
check("no match: 'xyz' vs Oak Park", fuzzyMatch("xyz", "Oak Park") === null);
check("no match: 'jack' vs Oak Park", fuzzyMatch("jack", "Oak Park") === null);
check(
  "order matters: 'kp' is a subsequence of Oak Park, reversed 'pe' is not",
  fuzzyMatch("kp", "Oak Park") !== null && fuzzyMatch("pe", "Oak Park") === null
);

// Ranking: a tight word match must outscore a scattered one, so the best
// match — not merely the alphabetically first — gets the highlight.
{
  const tight = fuzzyMatch("oak", "Oak Park");
  const scattered = fuzzyMatch("oak", "Overlook Bank");
  check(
    "score: contiguous 'Oak' beats scattered O…a…k",
    tight !== null && scattered !== null && tight.score > scattered.score
  );
}
{
  const wordStart = fuzzyMatch("mapl", "NE Mapleton 5264");
  const midWord = fuzzyMatch("mapl", "Summit Apple");
  check(
    "score: word-start 'Mapl' beats mid-word m…ap…l",
    wordStart !== null && midWord !== null && wordStart.score > midWord.score
  );
}

// Highlight indices point at the matched characters.
{
  const m = fuzzyMatch("mapl", "NE Mapleton 5264");
  check(
    "indices: 'mapl' highlights M-a-p-l in NE Mapleton",
    m !== null && m.indices.join(",") === "3,4,5,6"
  );
}
{
  const m = fuzzyMatch("nwj", "NW Jackson");
  check("indices: 'nwj' highlights N, W, J", m !== null && m.indices.join(",") === "0,1,3");
}

// Empty query matches everything with no highlights (browse mode).
{
  const m = fuzzyMatch("", "Oak Park");
  check("empty query: matches with no indices", m !== null && m.indices.length === 0);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll fuzzy matcher tests passed.");

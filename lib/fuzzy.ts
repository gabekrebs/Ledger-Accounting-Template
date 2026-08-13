/**
 * Subsequence fuzzy matcher for short human-typed queries over short names —
 * "nwj" finds "NW Johnson", "oak" finds every Oak Street. Returns a relevance
 * score plus the matched character indices (for highlighting), or null when
 * the query is not a subsequence of the text.
 *
 * Matching is greedy from every occurrence of the first query character,
 * keeping the best-scoring run. That is enough to prefer the contiguous
 * "Oak" in "Oak Street" over a scattered match without a full alignment —
 * the haystack here is a couple dozen property names, all short.
 */

export type FuzzyMatch = { score: number; indices: number[] };

// Per-character bonuses: starting a word beats continuing a run beats a
// scattered mid-word hit. Small penalties keep matches tight and early.
const WORD_START = 8;
const CONSECUTIVE = 6;
const SCATTERED = 1;
const GAP_PENALTY = 0.5; // per skipped char between two matched chars
const LEAD_PENALTY = 0.25; // per char before the first matched char

const ALNUM = /[\p{L}\p{N}]/u;

function isWordStart(text: string, i: number): boolean {
  return i === 0 || !ALNUM.test(text[i - 1]);
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return { score: 0, indices: [] };

  let best: FuzzyMatch | null = null;
  for (let start = t.indexOf(q[0]); start !== -1; start = t.indexOf(q[0], start + 1)) {
    let score = -start * LEAD_PENALTY;
    const indices: number[] = [];
    let from = start;
    for (const ch of q) {
      const at = t.indexOf(ch, from);
      if (at === -1) {
        // No subsequence from this anchor — later anchors only start further
        // right, so none can succeed either.
        return best;
      }
      const prev = indices[indices.length - 1];
      if (indices.length > 0) score -= (at - prev - 1) * GAP_PENALTY;
      if (isWordStart(t, at)) score += WORD_START;
      else if (indices.length > 0 && at === prev + 1) score += CONSECUTIVE;
      else score += SCATTERED;
      indices.push(at);
      from = at + 1;
    }
    if (!best || score > best.score) best = { score, indices };
  }
  return best;
}

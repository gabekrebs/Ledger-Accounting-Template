/**
 * READ-ONLY rules-engine verifier for a real entity — no writes, safe to run
 * against live books. Confirms the engine is wired correctly end to end:
 *   • loads the entity's effective rules (entity ∪ global, in precedence order)
 *   • for every pending transaction, shows the live rule match + whether it
 *     would AUTO-post or be PROPOSED (mirrors auto-post.ts exactly)
 *   • runs the zero-write dry-run preview for each active rule
 *
 *   npx tsx scripts/rules-engine-verify.mts --entity=<entityId>
 *
 * The WRITE-path scenarios from the plan (auto-apply posting, retroactive
 * recategorization, the FINGERPRINT_AUTOPOST=0 cutover, recognizer precedence)
 * mutate the immutable ledger and are exercised through the app and the
 * auto-poster itself — not from this script — so a verification run can never
 * touch the books. The pure predicate/facts/split-cents logic is covered by
 * scripts/rules-engine.test.mts.
 */
import fs from "fs";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "").replace(/\\n$/, "");
}

const entityId = process.argv
  .find((a) => a.startsWith("--entity="))
  ?.split("=")[1]
  ?.trim();
if (!entityId) {
  console.error("usage: npx tsx scripts/rules-engine-verify.mts --entity=<entityId>");
  process.exit(1);
}

const { loadRules, selectRule } = await import("../lib/rules/engine");
const { extractFacts } = await import("../lib/rules/facts");
const { buildFactsContext } = await import("../lib/rules/apply");
const { meetsAutoBar } = await import("../lib/rules/confidence");
const { previewRule } = await import("../lib/rules/preview");
const { listRulesForEntity, listProposedForEntity } = await import("../lib/rules/store");
const { listPendingTransactions } = await import("../lib/plaid/data");

const rules = await loadRules(entityId);
const all = await listRulesForEntity(entityId);
console.log(
  `\nEntity ${entityId}: ${rules.length} effective rule(s) ` +
    `(${all.filter((r) => r.scope === "global").length} global, ` +
    `${all.filter((r) => r.scope === "entity").length} entity), ` +
    `${all.filter((r) => r.autoApply).length} auto-apply.\n`
);

const [pending, ctx] = await Promise.all([
  listPendingTransactions(entityId),
  buildFactsContext(entityId),
]);

let autoN = 0;
let proposeN = 0;
console.log(`Pending transactions: ${pending.length}`);
for (const t of pending) {
  const facts = extractFacts(t, ctx);
  const match = selectRule(rules, facts);
  if (!match) continue;
  const auto = meetsAutoBar(match);
  if (auto) autoN++;
  else proposeN++;
  console.log(
    `  • ${(t.merchantName ?? t.name ?? "—").slice(0, 32).padEnd(32)} ` +
      `→ ${auto ? "AUTO " : "propose"} via “${match.name}”`
  );
}
console.log(`  (${autoN} would auto-post, ${proposeN} proposed)\n`);

console.log("Dry-run preview per active rule:");
for (const r of all.filter((x) => x.enabled && x.status === "active")) {
  const p = await previewRule(entityId, {
    scope: r.scope as "global" | "entity",
    rank: r.rank,
    predicate: r.predicate as never,
    action: r.action as never,
    excludeRuleId: r.id,
  });
  console.log(
    `  • ${r.name.padEnd(28)} pending=${p.pendingMatchCount} posted=${p.postedMatchCount}` +
      (p.unresolved.length ? ` UNRESOLVED=${p.unresolved.join(",")}` : "") +
      (p.conflicts.length ? ` conflicts=${p.conflicts.length}` : "")
  );
}

// Proposed rules awaiting approval (authored by the learner / AI).
const proposed = await listProposedForEntity(entityId);
console.log(`\nProposed rules awaiting approval: ${proposed.length}`);
for (const r of proposed) {
  console.log(`  • [${r.origin}] ${r.name}${r.description ? ` — ${r.description}` : ""}`);
}

// Fingerprint-retirement parity: every merchant the fingerprint would auto-post,
// and whether it's covered by an active rule, a proposal, or still uncovered.
const { fingerprintParity } = await import("../lib/rules/parity");
const parity = await fingerprintParity(entityId);
console.log(
  `\nFingerprint parity: ${parity.total} auto-postable merchant(s) — ` +
    `${parity.active} on active rules, ${parity.proposed} proposed, ${parity.uncovered} UNCOVERED`
);
if (parity.uncovered > 0) {
  console.log("  Uncovered (fingerprint value not yet captured as a rule):");
  for (const e of parity.entries.filter((x) => x.coverage === "uncovered")) {
    console.log(`    • ${e.merchant} (${e.source}, ${e.samples} samples)`);
  }
} else {
  console.log("  ✓ every fingerprint merchant is covered by an active or proposed rule.");
}

console.log("\n✅ read-only verification complete (no writes performed).");
process.exit(0);

/**
 * Grant a user access to specific ledger entities (writes bk_entity_access).
 * Only needed for NON-admin users — admins (AUTH_ADMIN_EMAILS) see everything.
 *
 *   npx tsx scripts/grant-entity-access.mts --email=partner@example.com --entities=glisan,salmon
 *
 * --entities accepts entity name substrings, realm ids, or the wave: slug tail
 * (e.g. "glisan", "salmon", "wave:glisan-ne-775", "1025"). Idempotent:
 * re-granting an existing pair is a no-op. Pass --list to print current grants
 * for the email instead of granting.
 */
import fs from "fs";
import { eq, and } from "drizzle-orm";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const { db, schema } = await import("../lib/db/client");
const { bkLedgerEntities, bkEntityAccess } = schema;

const args = process.argv.slice(2);
const email = args
  .find((a) => a.startsWith("--email="))
  ?.split("=")[1]
  ?.trim()
  .toLowerCase();
const entitiesArg = args.find((a) => a.startsWith("--entities="))?.split("=")[1];
const listOnly = args.includes("--list");

if (!email) {
  console.error(
    "usage: npx tsx scripts/grant-entity-access.mts --email=<e> --entities=glisan,salmon [--list]"
  );
  process.exit(1);
}

const all = await db
  .select({
    id: bkLedgerEntities.id,
    name: bkLedgerEntities.name,
    realmId: bkLedgerEntities.realmId,
  })
  .from(bkLedgerEntities);

if (listOnly) {
  const rows = await db
    .select({ entityId: bkEntityAccess.entityId })
    .from(bkEntityAccess)
    .where(eq(bkEntityAccess.userEmail, email));
  const granted = new Set(rows.map((r) => r.entityId));
  console.log(`grants for ${email}:`);
  for (const e of all)
    if (granted.has(e.id)) console.log(`  ✓ ${e.name} [${e.realmId}]`);
  if (!granted.size) console.log("  (none)");
  process.exit(0);
}

if (!entitiesArg) {
  console.error("--entities is required (or use --list)");
  process.exit(1);
}

// Resolve each token to exactly one entity (by name substring / realm / slug tail).
const tokens = entitiesArg
  .split(",")
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);
const resolved: { token: string; id: string; name: string | null }[] = [];
for (const tok of tokens) {
  const matches = all.filter(
    (e) =>
      (e.name ?? "").toLowerCase().includes(tok) ||
      e.realmId.toLowerCase().includes(tok)
  );
  if (matches.length === 0) {
    console.error(`✗ no entity matches "${tok}"`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(
      `✗ "${tok}" is ambiguous: ${matches.map((m) => m.name).join(", ")}`
    );
    process.exit(1);
  }
  resolved.push({ token: tok, id: matches[0].id, name: matches[0].name });
}

for (const r of resolved) {
  const existing = await db
    .select({ id: bkEntityAccess.id })
    .from(bkEntityAccess)
    .where(
      and(
        eq(bkEntityAccess.userEmail, email),
        eq(bkEntityAccess.entityId, r.id)
      )
    );
  if (existing[0]) {
    console.log(`• already granted: ${r.name}`);
    continue;
  }
  await db.insert(bkEntityAccess).values({ userEmail: email, entityId: r.id });
  console.log(`✓ granted ${email} → ${r.name}`);
}
process.exit(0);

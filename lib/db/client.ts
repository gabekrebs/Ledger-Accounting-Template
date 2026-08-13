import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Drizzle client over the shared Supabase Postgres (direct connection).
 *
 * SUPABASE_DB_URL in .env.local has a trailing literal `\n` — trim it or the
 * connection string is malformed. Low-traffic internal app, so a tiny pool is
 * plenty; if Vercel serverless connection limits bite later, switch to the
 * Supabase transaction pooler URL (port 6543) + `prepare: false`.
 */
function getConnectionString(): string {
  const raw = process.env.SUPABASE_DB_URL;
  if (!raw) throw new Error("SUPABASE_DB_URL is not set");
  return raw.trim().replace(/\\n$/, "");
}

declare global {
  var __bkSql: ReturnType<typeof postgres> | undefined;
}

// Reuse one client across hot-reloads / warm lambdas.
const client =
  global.__bkSql ??
  postgres(getConnectionString(), {
    ssl: "require",
    // A page render fans out ~15-20 small queries in parallel; with the
    // transaction pooler in front (which multiplexes onto a few real DB
    // connections) a larger client pool lets those run concurrently instead of
    // queueing 3-at-a-time. Safe because the pooler — not this pool — is what
    // the 60-connection DB limit actually sees.
    max: 12,
    idle_timeout: 20,
    prepare: false,
  });
if (process.env.NODE_ENV !== "production") global.__bkSql = client;

export const db = drizzle(client, { schema });
export { schema };

/**
 * A transaction handle (the `tx` drizzle hands to a `db.transaction` callback),
 * and a "database OR transaction" executor. Functions that must take part in a
 * caller's transaction accept one of these as an OPTIONAL param defaulting to
 * `db`, so existing callers are unchanged while atomic callers can pass `tx`.
 */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | DbTx;

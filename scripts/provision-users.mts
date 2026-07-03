/**
 * Provision login accounts for every email in AUTH_ALLOWED_EMAILS using the
 * Supabase service-role Admin API — no SMTP / email confirmation needed.
 * Idempotent: existing users are left untouched (their password is not reset).
 *
 *   npx tsx scripts/provision-users.mts
 *
 * Prints a temporary password for each NEW account. Share it securely; users
 * can change it later. To add people: edit AUTH_ALLOWED_EMAILS, re-run.
 */
import fs from "fs";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const emails = (process.env.AUTH_ALLOWED_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

if (!emails.length) {
  console.error("AUTH_ALLOWED_EMAILS is empty — nothing to provision.");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function tempPassword(): string {
  // 18 url-safe chars — strong, easy to copy.
  return crypto.randomBytes(14).toString("base64url");
}

const created: { email: string; password: string }[] = [];

for (const email of emails) {
  const password = tempPassword();
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (!error) {
    created.push({ email, password });
    console.log(`✓ created ${email}`);
  } else if (/already|exists|registered/i.test(error.message)) {
    console.log(`• exists, left as-is: ${email}`);
  } else {
    console.log(`✗ ${email}: ${error.message}`);
  }
}

if (created.length) {
  console.log("\n=== TEMPORARY PASSWORDS (share securely, then delete) ===");
  for (const c of created) console.log(`${c.email}  ${c.password}`);
}
process.exit(0);

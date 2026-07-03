import crypto from "crypto";

/**
 * App-layer encryption for Plaid access tokens at rest. A stored token is a live
 * key to a real bank connection, so we don't keep it plaintext in the shared
 * Supabase DB — it's AES-256-GCM encrypted with PLAID_TOKEN_KEY (32 bytes,
 * base64) and only decrypted server-side right before a Plaid API call.
 *
 * Stored form: "enc:v1:" + base64(iv[12] | authTag[16] | ciphertext). The prefix
 * lets decrypt pass through any legacy plaintext untouched.
 */
const PREFIX = "enc:v1:";

function key(): Buffer {
  const raw = process.env.PLAID_TOKEN_KEY;
  if (!raw) throw new Error("PLAID_TOKEN_KEY is not set");
  const k = Buffer.from(raw.trim(), "base64");
  if (k.length !== 32) {
    throw new Error("PLAID_TOKEN_KEY must decode to 32 bytes (base64)");
  }
  return k;
}

export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptToken(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext, pass through
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8"
  );
}

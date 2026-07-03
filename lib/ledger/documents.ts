import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bkDocuments } from "@/lib/db/schema";
import { getServerSupabase } from "@/lib/supabase/server";

/**
 * Per-entity document vault. Files live in the PRIVATE Supabase Storage bucket
 * `entity-documents`; this module is the only place that touches storage + the
 * `bk_documents` metadata table. Access is gated by the caller (server actions
 * assert entity access first) — every read/write is scoped to an entityId so a
 * document can never be reached from outside its entity. Files are served ONLY
 * via short-lived signed URLs (never a public link), because these PDFs carry
 * PII (SSNs/TINs on 1098s, etc.).
 */
const BUCKET = "entity-documents";

export interface LedgerDocument {
  id: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number | null;
  docType: string | null;
  docYear: number | null;
  label: string | null;
  uploadedBy: string | null;
  createdAt: Date | null;
}

export async function listDocuments(entityId: string): Promise<LedgerDocument[]> {
  return db
    .select({
      id: bkDocuments.id,
      fileName: bkDocuments.fileName,
      contentType: bkDocuments.contentType,
      sizeBytes: bkDocuments.sizeBytes,
      docType: bkDocuments.docType,
      docYear: bkDocuments.docYear,
      label: bkDocuments.label,
      uploadedBy: bkDocuments.uploadedBy,
      createdAt: bkDocuments.createdAt,
    })
    .from(bkDocuments)
    .where(eq(bkDocuments.entityId, entityId))
    .orderBy(desc(bkDocuments.docYear), desc(bkDocuments.createdAt));
}

export async function uploadDocument(
  entityId: string,
  input: {
    fileName: string;
    contentType: string | null;
    bytes: Uint8Array;
    sizeBytes: number;
    docType: string | null;
    docYear: number | null;
    label: string | null;
    uploadedBy: string | null;
  }
): Promise<void> {
  const safe = input.fileName.replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  const path = `${entityId}/${randomUUID()}-${safe}`;
  const sb = getServerSupabase();
  const { error } = await sb.storage
    .from(BUCKET)
    .upload(path, input.bytes, {
      contentType: input.contentType ?? "application/octet-stream",
      upsert: false,
    });
  if (error) throw new Error(`Document upload failed: ${error.message}`);
  await db.insert(bkDocuments).values({
    entityId,
    storagePath: path,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    docType: input.docType,
    docYear: input.docYear,
    label: input.label,
    uploadedBy: input.uploadedBy,
  });
}

/** Short-lived signed URL for viewing/downloading a doc (default 1h). Returns
 * null if the doc isn't in this entity (defends against id swapping). */
export async function signedUrl(
  entityId: string,
  docId: string,
  ttlSeconds = 3600
): Promise<string | null> {
  const [doc] = await db
    .select({ path: bkDocuments.storagePath })
    .from(bkDocuments)
    .where(and(eq(bkDocuments.id, docId), eq(bkDocuments.entityId, entityId)))
    .limit(1);
  if (!doc) return null;
  const { data, error } = await getServerSupabase()
    .storage.from(BUCKET)
    .createSignedUrl(doc.path, ttlSeconds);
  return error ? null : data.signedUrl;
}

export async function deleteDocument(entityId: string, docId: string): Promise<void> {
  const [doc] = await db
    .select({ path: bkDocuments.storagePath })
    .from(bkDocuments)
    .where(and(eq(bkDocuments.id, docId), eq(bkDocuments.entityId, entityId)))
    .limit(1);
  if (!doc) return;
  await getServerSupabase().storage.from(BUCKET).remove([doc.path]);
  await db
    .delete(bkDocuments)
    .where(and(eq(bkDocuments.id, docId), eq(bkDocuments.entityId, entityId)));
}

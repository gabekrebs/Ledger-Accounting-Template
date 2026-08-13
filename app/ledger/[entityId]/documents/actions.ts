"use server";

import { revalidatePath } from "next/cache";
import {
  assertAdmin,
  assertEntityAccess,
  assertEntityWrite,
} from "@/lib/ledger/access";
import { logAudit } from "@/lib/ledger/audit";
import { limitAction } from "@/lib/security/rate-limit";
import { actionIdentity } from "@/lib/security/rate-limit-identity";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  uploadDocument,
  deleteDocument,
  signedUrl,
} from "@/lib/ledger/documents";
import { str } from "@/lib/ledger/forms";

// Per-file ceiling — matches the server-action bodySizeLimit in next.config.ts
// but fails with a READABLE error before buffering, instead of Next's opaque
// body-size rejection.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function uploadDocumentAction(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityWrite(entityId);
  const rl = await limitAction("document", await actionIdentity());
  if (rl) throw new Error(rl.error);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB; max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const yearRaw = str(formData.get("docYear"));
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
  const user = await getCurrentUser();
  await uploadDocument(entityId, {
    fileName: file.name,
    contentType: file.type || null,
    bytes,
    sizeBytes: file.size,
    docType: str(formData.get("docType")),
    docYear: year,
    label: str(formData.get("label")),
    uploadedBy: user?.email ?? null,
  });
  await logAudit({
    entityId,
    actionType: "upload_document",
    objectTable: "bk_documents",
    objectId: null,
    description: `Uploaded document "${file.name}"${year ? ` (${year})` : ""}`,
    after: { fileName: file.name, docYear: year },
    affectedLedger: false,
  });
  revalidatePath(`/ledger/${entityId}/documents`);
}

/** Deleting documents is ADMIN-ONLY (tax PII); a write-user cannot remove them. */
export async function deleteDocumentAction(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertAdmin();
  await deleteDocument(entityId, String(formData.get("docId")));
  revalidatePath(`/ledger/${entityId}/documents`);
}

/**
 * useActionState handler: returns a 7-day signed link to share with a CPA.
 * Available to read-access users (viewing is allowed), but a download by a
 * non-admin is LOGGED for review because these PDFs carry tax PII.
 */
export async function createShareLinkAction(
  _prev: { docId?: string; url?: string; error?: string } | null,
  formData: FormData
): Promise<{ docId?: string; url?: string; error?: string }> {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const rl = await limitAction("document", await actionIdentity());
  if (rl) return { error: rl.error };
  const docId = String(formData.get("docId"));
  const url = await signedUrl(entityId, docId, 7 * 24 * 3600);
  if (!url) return { docId, error: "Could not create link." };
  await logAudit({
    entityId,
    actionType: "download_document",
    objectTable: "bk_documents",
    objectId: docId,
    description: "Generated a download link for a document",
    affectedLedger: false,
  });
  return { docId, url };
}

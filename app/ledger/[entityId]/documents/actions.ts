"use server";

import { revalidatePath } from "next/cache";
import { assertEntityAccess } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  uploadDocument,
  deleteDocument,
  signedUrl,
} from "@/lib/ledger/documents";

function str(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

// Per-file ceiling — matches the server-action bodySizeLimit in next.config.ts
// but fails with a READABLE error before buffering, instead of Next's opaque
// body-size rejection.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function uploadDocumentAction(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
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
  revalidatePath(`/ledger/${entityId}/documents`);
}

export async function deleteDocumentAction(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  await deleteDocument(entityId, String(formData.get("docId")));
  revalidatePath(`/ledger/${entityId}/documents`);
}

/** useActionState handler: returns a 7-day signed link to share with a CPA. */
export async function createShareLinkAction(
  _prev: { docId?: string; url?: string; error?: string } | null,
  formData: FormData
): Promise<{ docId?: string; url?: string; error?: string }> {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const docId = String(formData.get("docId"));
  const url = await signedUrl(entityId, docId, 7 * 24 * 3600);
  return url ? { docId, url } : { docId, error: "Could not create link." };
}

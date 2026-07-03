import { notFound } from "next/navigation";
import { assertEntityAccess } from "@/lib/ledger/access";
import { getEntity } from "@/lib/ledger/reports";
import { listDocuments, signedUrl } from "@/lib/ledger/documents";
import { Section } from "../section";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { uploadDocumentAction, deleteDocumentAction } from "./actions";
import { ShareButton } from "./share-button";

export const dynamic = "force-dynamic";

const DOC_TYPES: { value: string; label: string }[] = [
  { value: "1098", label: "1098 (mortgage interest)" },
  { value: "1099", label: "1099" },
  { value: "settlement_statement", label: "Settlement statement" },
  { value: "tax_return", label: "Tax return" },
  { value: "insurance", label: "Insurance" },
  { value: "escrow_analysis", label: "Escrow analysis" },
  { value: "other", label: "Other" },
];
const TYPE_LABEL = Object.fromEntries(DOC_TYPES.map((d) => [d.value, d.label.replace(/ \(.*\)/, "")]));

function fmtSize(b: number | null) {
  if (!b) return "—";
  return b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default async function DocumentsPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  await assertEntityAccess(entityId);
  const entity = await getEntity(entityId);
  if (!entity) notFound();
  const docs = await listDocuments(entityId);
  // Short-lived view URLs generated server-side (the bucket is private).
  const urls = new Map(
    await Promise.all(docs.map(async (d) => [d.id, await signedUrl(entityId, d.id, 3600)] as const))
  );

  return (
    <div className="space-y-8">
      <Section
        title="Documents"
        description="Settlement statements, 1098s, insurance, tax returns — stored privately, shareable with your CPA via a time-limited link."
      >
        <form action={uploadDocumentAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 items-end">
          <input type="hidden" name="entityId" value={entityId} />
          <label className="block text-sm sm:col-span-2 lg:col-span-1">
            <span className="text-muted-foreground">File</span>
            <input type="file" name="file" required className="mt-1 block w-full text-sm" />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Type</span>
            <select name="docType" className="mt-1 h-9 w-full rounded-md border border-hair bg-card px-3 text-sm">
              {DOC_TYPES.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Year</span>
            <Input name="docYear" inputMode="numeric" placeholder="2023" className="mt-1" />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Label (optional)</span>
            <Input name="label" placeholder="e.g. Freedom Mortgage" className="mt-1" />
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit">Upload</Button>
          </div>
        </form>
      </Section>

      <Section title="Stored documents" description={`${docs.length} document${docs.length === 1 ? "" : "s"}.`}>
        {docs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No documents yet. Upload settlement statements, 1098s, and tax forms above.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                <th className="py-2 text-left font-medium">Year</th>
                <th className="py-2 text-left font-medium">Type</th>
                <th className="py-2 text-left font-medium">Document</th>
                <th className="py-2 text-right font-medium">Size</th>
                <th className="py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b border-hair/60 align-top">
                  <td className="py-2.5 font-mono tabular-nums">{d.docYear ?? "—"}</td>
                  <td className="py-2.5 text-muted-foreground">{d.docType ? (TYPE_LABEL[d.docType] ?? d.docType) : "—"}</td>
                  <td className="py-2.5">
                    {urls.get(d.id) ? (
                      <a href={urls.get(d.id)!} target="_blank" rel="noopener noreferrer" className="hover:text-evergreen hover:underline">
                        {d.label ? `${d.label} — ${d.fileName}` : d.fileName}
                      </a>
                    ) : (
                      <span>{d.fileName}</span>
                    )}
                    {d.uploadedBy && <div className="text-[11px] text-faint">added by {d.uploadedBy}</div>}
                  </td>
                  <td className="py-2.5 text-right font-mono tabular-nums text-muted-foreground">{fmtSize(d.sizeBytes)}</td>
                  <td className="py-2.5">
                    <div className="flex items-center justify-end gap-3">
                      <ShareButton entityId={entityId} docId={d.id} />
                      <form action={deleteDocumentAction}>
                        <input type="hidden" name="entityId" value={entityId} />
                        <input type="hidden" name="docId" value={d.id} />
                        <button type="submit" className="text-xs text-muted-foreground hover:text-oxblood">Delete</button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

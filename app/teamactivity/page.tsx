import Link from "next/link";
import { assertAdmin } from "@/lib/ledger/access";
import {
  unreviewedByEntity,
  reviewedHistory,
  type AuditRow,
} from "@/lib/ledger/audit-review";
import { markReviewedAction, markEntityReviewedAction } from "./actions";

export const dynamic = "force-dynamic";

function fmtDate(d: Date | null): string {
  if (!d) return "";
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function roleLabel(role: string): string {
  if (role === "accountant") return "Accountant";
  if (role === "business_partner") return "Business Partner";
  if (role === "system") return "System";
  return role;
}

function Row({ row, reviewed }: { row: AuditRow; reviewed: boolean }) {
  return (
    <li className="flex items-start justify-between gap-3 border-t border-hair py-2.5 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm">
          {row.description}
          {row.affectedLedger && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              ledger
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-faint">
          {row.actorEmail} · {roleLabel(row.actorRole)} · {fmtDate(row.createdAt)}
          {reviewed && row.reviewedAt ? ` · reviewed ${fmtDate(row.reviewedAt)}` : ""}
        </p>
      </div>
      <form action={markReviewedAction.bind(null, row.id, !reviewed)}>
        <button
          type="submit"
          className={
            reviewed
              ? "shrink-0 rounded-md border border-hair px-2.5 py-1 text-xs text-faint hover:border-evergreen/40"
              : "shrink-0 rounded-md border border-evergreen/40 bg-evergreen/10 px-2.5 py-1 text-xs font-medium text-evergreen hover:bg-evergreen/20"
          }
        >
          {reviewed ? "Undo" : "Reviewed"}
        </button>
      </form>
    </li>
  );
}

export default async function TeamActivityPage() {
  await assertAdmin(); // 404s for non-admins — only the owner sees this

  const [groups, history] = await Promise.all([
    unreviewedByEntity(),
    reviewedHistory(200),
  ]);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <main className="flex-1 px-6 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-medium">Team Activity</h1>
          <Link href="/" className="text-sm text-faint hover:text-evergreen">
            ← Home
          </Link>
        </div>
        <p className="mt-1 text-sm text-faint">
          Changes made by accountants and business partners with write access,
          plus system alerts (e.g. bank data changing under a posted
          transaction). Your own changes are not tracked here.
        </p>

        {total === 0 ? (
          <p className="mt-10 rounded-lg border border-hair bg-background p-6 text-center text-sm text-faint">
            Nothing to review — you&rsquo;re all caught up.
          </p>
        ) : (
          <div className="mt-8 space-y-6">
            {groups.map((g) => (
              <section key={g.entityId} className="rounded-lg border border-hair bg-background p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold">
                    {g.entityName ?? "(unknown entity)"}
                    <span className="ml-2 text-xs font-normal text-faint">
                      {g.rows.length} to review
                    </span>
                  </h2>
                  <form action={markEntityReviewedAction.bind(null, g.entityId)}>
                    <button
                      type="submit"
                      className="rounded-md border border-hair px-2.5 py-1 text-xs text-faint hover:border-evergreen/40 hover:text-evergreen"
                    >
                      Mark all reviewed
                    </button>
                  </form>
                </div>
                <ul className="mt-2">
                  {g.rows.map((r) => (
                    <Row key={r.id} row={r} reviewed={false} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <details className="mt-10 group">
          <summary className="cursor-pointer text-sm text-faint hover:text-evergreen">
            Reviewed history ({history.length})
          </summary>
          {history.length > 0 ? (
            <ul className="mt-3 rounded-lg border border-hair bg-background p-4">
              {history.map((r) => (
                <Row key={r.id} row={r} reviewed={true} />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-faint">No reviewed items yet.</p>
          )}
        </details>
      </div>
    </main>
  );
}

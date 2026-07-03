import Link from "next/link";
import {
  generalLedgerReport,
  ledgerStats,
  type GlAccountSection,
} from "@/lib/ledger/reports";
import { resolvePlPeriod } from "@/lib/ledger/pl-period";
import { Money } from "@/components/money";
import { PlDateControls } from "../pl/date-controls";
import { EditTransactionButton } from "../edit-transaction";

export const dynamic = "force-dynamic";

/**
 * Full general ledger report (QuickBooks "General Ledger") — every account
 * with activity in the period, its postings with a running balance, and a
 * self-checking debits = credits foot. Each account header links to that
 * account's full-history drill-down (`gl/[accountId]`).
 */
export default async function GeneralLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ entityId: string }>;
  searchParams: Promise<{ year?: string; start?: string; end?: string }>;
}) {
  const { entityId } = await params;
  const sp = await searchParams;
  const stats = await ledgerStats(entityId);
  const firstYear = stats.firstDate ? +stats.firstDate.slice(0, 4) : 2022;
  const lastYear = stats.lastDate ? +stats.lastDate.slice(0, 4) : 2026;
  const years: number[] = [];
  for (let y = lastYear; y >= firstYear; y--) years.push(y);

  const period = resolvePlPeriod(sp, new Date());
  const { sections, totalDebitCents, totalCreditCents } =
    await generalLedgerReport(entityId, period.opts);
  const lineCount = sections.reduce((n, s) => n + s.rows.length, 0);
  const base = `/ledger/${entityId}/gl`;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-serif text-xl font-medium tracking-tight">
          General Ledger
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {period.periodLabel} · {sections.length} accounts · {lineCount}{" "}
          postings · debits <Money cents={totalDebitCents} className="text-xs" />{" "}
          = credits <Money cents={totalCreditCents} className="text-xs" />
        </p>
      </div>

      <PlDateControls
        base={base}
        years={years}
        presets={period.presets}
        activePreset={period.activePreset}
        activeYear={period.activeYear}
        customRange={period.customRange}
        showCompare={false}
      />

      {sections.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No postings in this period.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              <th className="py-2 text-left font-medium">Date</th>
              <th className="py-2 text-left font-medium">Type</th>
              <th className="py-2 text-left font-medium">Name / Memo</th>
              <th className="py-2 text-right font-medium">Debit</th>
              <th className="py-2 text-right font-medium">Credit</th>
              <th className="py-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          {sections.map((s) => (
            <AccountSection key={s.qboAccountId} entityId={entityId} s={s} />
          ))}
          <tfoot>
            <tr className="border-t-2 border-hair font-medium">
              <td colSpan={3} className="py-3">
                Total
              </td>
              <td className="py-3 text-right">
                <Money cents={totalDebitCents} />
              </td>
              <td className="py-3 text-right">
                <Money cents={totalCreditCents} />
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

function AccountSection({
  entityId,
  s,
}: {
  entityId: string;
  s: GlAccountSection;
}) {
  return (
    <tbody>
      <tr className="border-b border-hair">
        <td colSpan={6} className="pb-1.5 pt-6">
          <Link
            href={`/ledger/${entityId}/gl/${s.qboAccountId}`}
            className="font-medium text-foreground hover:text-evergreen"
          >
            {s.fullyQualifiedName ?? s.name}
          </Link>
          <span className="ml-2 text-xs text-faint">{s.accountType}</span>
        </td>
      </tr>
      {s.openingCents !== null && (
        <tr className="border-b border-hair/60">
          <td className="py-2.5" />
          <td className="py-2.5" />
          <td className="py-2.5 text-xs text-faint">Opening balance</td>
          <td />
          <td />
          <td className="py-2.5 text-right text-muted-foreground">
            <Money cents={s.openingCents} tone="auto" />
          </td>
        </tr>
      )}
      {s.rows.map((r, i) => (
        <tr key={`${r.entryId}-${i}`} className="border-b border-hair/60">
          <td className="whitespace-nowrap py-2.5 font-mono tabular-nums text-muted-foreground">
            {r.txnDate}
          </td>
          <td className="whitespace-nowrap py-2.5 text-xs text-faint">
            <Link
              href={`/ledger/${entityId}/transactions?q=${encodeURIComponent(r.qboTxnId ?? "")}`}
              className="hover:text-evergreen hover:underline"
            >
              {r.qboTxnType}
            </Link>
          </td>
          <td className="max-w-md truncate py-2.5 text-muted-foreground">
            {r.name ? <span className="text-foreground">{r.name}</span> : null}
            {r.name && (r.lineMemo || r.memo) ? " · " : null}
            <span className="text-faint">{r.lineMemo || r.memo}</span>
          </td>
          <td className="py-2.5 text-right">
            {r.debitCents ? <Money cents={r.debitCents} /> : ""}
          </td>
          <td className="py-2.5 text-right">
            {r.creditCents ? <Money cents={r.creditCents} /> : ""}
          </td>
          <td className="py-2.5 text-right text-muted-foreground">
            <span className="inline-flex items-center justify-end gap-1.5">
              <Money cents={r.runningCents} tone="auto" />
              <EditTransactionButton
                entityId={entityId}
                entryId={r.entryId}
                edited={!!r.editedAt}
              />
            </span>
          </td>
        </tr>
      ))}
      <tr className="border-b border-hair text-muted-foreground">
        <td colSpan={3} className="py-2.5 text-xs">
          Ending balance — {s.name}
        </td>
        <td className="py-2.5 text-right">
          <Money cents={s.debitCents} />
        </td>
        <td className="py-2.5 text-right">
          <Money cents={s.creditCents} />
        </td>
        <td className="py-2.5 text-right font-medium">
          <Money cents={s.endingCents} tone="auto" />
        </td>
      </tr>
    </tbody>
  );
}

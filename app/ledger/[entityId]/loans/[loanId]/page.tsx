import Link from "next/link";
import { notFound } from "next/navigation";
import { accountBalances } from "@/lib/ledger/reports";
import { getLoan } from "@/lib/ledger/loans";
import { amortize, summarize, amortizeFromNow, summarizeFromNow } from "@/lib/ledger/amortization";
import { Section } from "../../section";
import { Money } from "@/components/money";
import { AmortizationChart } from "../amortization-chart";
import { Button } from "@/components/ui/button";
import { LoanForm } from "../loan-form";
import { removeLoan } from "../actions";

export const dynamic = "force-dynamic";

export default async function LoanDetail({
  params,
}: {
  params: Promise<{ entityId: string; loanId: string }>;
}) {
  const { entityId, loanId } = await params;
  const loan = await getLoan(entityId, loanId);
  if (!loan) notFound();

  const bals = await accountBalances(entityId);
  const liabilityAccounts = bals
    .filter((b) => b.accountType === "Long Term Liability" || b.accountType === "Other Current Liability")
    .map((b) => ({ qboAccountId: b.qboAccountId, name: b.name }));
  const interestAccounts = bals
    .filter((b) => b.classification === "expense")
    .map((b) => ({ qboAccountId: b.qboAccountId, name: b.name }));
  // Funding side of auto-recognition — the bank account that pays the loan.
  const bankAccounts = bals
    .filter((b) => b.accountType === "Bank" && b.active)
    .map((b) => ({ qboAccountId: b.qboAccountId, name: b.name }));

  const today = new Date().toISOString().slice(0, 10);

  // Prefer "remaining term" path for accuracy after a refi; fall back to
  // legacy full-terms path when remainingTermMonths is not set.
  const liabilityBal = bals.find((b) => b.qboAccountId === loan.liabilityAccountQboId);
  const currentBalanceCents = liabilityBal ? -liabilityBal.netCents : 0;

  const useCurrentPath =
    loan.remainingTermMonths != null &&
    loan.annualRateBps != null &&
    currentBalanceCents > 0;

  const sum = useCurrentPath
    ? summarizeFromNow({
        currentBalanceCents,
        annualRateBps: loan.annualRateBps!,
        remainingTermMonths: loan.remainingTermMonths!,
        monthlyPaymentCents: loan.monthlyPaymentCents,
        monthlyEscrowCents: loan.monthlyEscrowCents,
        asOfDate: today,
      })
    : loan.originalPrincipalCents != null && loan.annualRateBps != null && loan.termMonths != null && loan.firstPaymentDate
    ? summarize({
        originalPrincipalCents: loan.originalPrincipalCents,
        annualRateBps: loan.annualRateBps,
        termMonths: loan.termMonths,
        firstPaymentDate: loan.firstPaymentDate,
        monthlyPaymentCents: loan.monthlyPaymentCents,
        monthlyEscrowCents: loan.monthlyEscrowCents,
      })
    : null;

  const schedule = useCurrentPath
    ? amortizeFromNow({
        currentBalanceCents,
        annualRateBps: loan.annualRateBps!,
        remainingTermMonths: loan.remainingTermMonths!,
        monthlyPaymentCents: loan.monthlyPaymentCents,
        monthlyEscrowCents: loan.monthlyEscrowCents,
        asOfDate: today,
      })
    : loan.originalPrincipalCents != null && loan.annualRateBps != null && loan.termMonths != null && loan.firstPaymentDate
    ? amortize({
        originalPrincipalCents: loan.originalPrincipalCents,
        annualRateBps: loan.annualRateBps,
        termMonths: loan.termMonths,
        firstPaymentDate: loan.firstPaymentDate,
        monthlyPaymentCents: loan.monthlyPaymentCents,
        monthlyEscrowCents: loan.monthlyEscrowCents,
      })
    : [];

  const nextIdx = schedule.findIndex((r) => r.date >= today);

  return (
    <div className="space-y-10">
      <div>
        <Link href={`/ledger/${entityId}/loans`} className="text-sm text-faint hover:text-muted-foreground">
          ← Loans
        </Link>
      </div>

      <Section title={loan.name} description={loan.lender ?? "—"}>
        <div className="grid grid-cols-2 gap-x-10 gap-y-4 sm:grid-cols-4">
          {useCurrentPath ? (
            <Stat label="Current balance" value={<Money cents={currentBalanceCents} />} />
          ) : loan.originalPrincipalCents != null ? (
            <Stat label="Original principal" value={<Money cents={loan.originalPrincipalCents} />} />
          ) : null}
          {loan.annualRateBps != null && (
            <Stat label="Rate" value={`${(loan.annualRateBps / 100).toFixed(3)}%`} />
          )}
          {useCurrentPath && loan.remainingTermMonths != null ? (
            <Stat label="Remaining term" value={`${(loan.remainingTermMonths / 12).toFixed(1)} yrs`} />
          ) : loan.termMonths != null ? (
            <Stat label="Term" value={`${(loan.termMonths / 12).toFixed(0)} yrs`} />
          ) : null}
          {sum && <Stat label="Monthly P&I" value={<Money cents={sum.paymentCents} />} />}
          <Stat label="Monthly escrow" value={<Money cents={loan.monthlyEscrowCents} />} />
          {!useCurrentPath && loan.firstPaymentDate && (
            <Stat label="First payment" value={loan.firstPaymentDate} />
          )}
          {sum && <Stat label="Payoff date" value={sum.payoffDate ?? "—"} />}
          {sum && <Stat label="Remaining interest" value={<Money cents={sum.totalInterestCents} />} />}
        </div>
        {loan.notes && <p className="mt-4 text-sm text-muted-foreground">{loan.notes}</p>}
      </Section>

      <Section title="Amortization" description={`${schedule.length} payments remaining. Each payment splits between interest and principal.`}>
        <AmortizationChart schedule={schedule} />
      </Section>

      <Section title="Schedule" description="The next due payment is highlighted.">
        <div className="max-h-[28rem] overflow-auto rounded-lg border border-hair">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                <th className="px-3 py-2 text-left font-medium">#</th>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-right font-medium">Payment</th>
                <th className="px-3 py-2 text-right font-medium">Interest</th>
                <th className="px-3 py-2 text-right font-medium">Principal</th>
                {loan.monthlyEscrowCents > 0 && <th className="px-3 py-2 text-right font-medium">Escrow</th>}
                <th className="px-3 py-2 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((r, i) => (
                <tr key={r.period} className={`border-b border-hair/50 ${i === nextIdx ? "bg-evergreen-soft" : ""}`}>
                  <td className="px-3 py-2 font-mono tabular-nums text-faint">{r.period}</td>
                  <td className="px-3 py-2 font-mono tabular-nums">{r.date}</td>
                  <td className="px-3 py-2 text-right"><Money cents={r.paymentCents} /></td>
                  <td className="px-3 py-2 text-right text-oxblood/80"><Money cents={r.interestCents} /></td>
                  <td className="px-3 py-2 text-right"><Money cents={r.principalCents} /></td>
                  {loan.monthlyEscrowCents > 0 && <td className="px-3 py-2 text-right"><Money cents={r.escrowCents} /></td>}
                  <td className="px-3 py-2 text-right text-muted-foreground"><Money cents={r.balanceCents} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Edit terms">
        <LoanForm entityId={entityId} liabilityAccounts={liabilityAccounts} interestAccounts={interestAccounts} bankAccounts={bankAccounts} loan={loan} />
        <form action={removeLoan} className="border-t border-hair pt-4">
          <input type="hidden" name="entityId" value={entityId} />
          <input type="hidden" name="loanId" value={loan.id} />
          <Button type="submit" variant="destructive">Delete loan</Button>
        </form>
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-serif text-lg font-medium tracking-tight tabular-nums">{value}</div>
    </div>
  );
}

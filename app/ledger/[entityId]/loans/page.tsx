import Link from "next/link";
import { accountBalances } from "@/lib/ledger/reports";
import { listLoans } from "@/lib/ledger/loans";
import { summarize, summarizeFromNow } from "@/lib/ledger/amortization";
import { currentUserEntityAccessLevel } from "@/lib/ledger/access";
import { Section } from "../section";
import { Money } from "@/components/money";
import { LoanForm } from "./loan-form";

export const dynamic = "force-dynamic";

export default async function LoansPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  const [loans, bals, accessLevel] = await Promise.all([
    listLoans(entityId),
    accountBalances(entityId),
    currentUserEntityAccessLevel(entityId),
  ]);
  const readOnly = accessLevel !== "write";

  const liabilityAccounts = bals
    .filter(
      (b) =>
        (b.accountType === "Long Term Liability" ||
          b.accountType === "Other Current Liability") &&
        b.active &&
        b.netCents !== 0 // a loan's balance source must be a live, non-empty liability
    )
    .map((b) => ({ qboAccountId: b.qboAccountId, name: b.name }));
  const interestAccounts = bals
    .filter((b) => b.classification === "expense")
    .map((b) => ({ qboAccountId: b.qboAccountId, name: b.name }));
  // Funding side of auto-recognition — the bank account that pays the loan.
  const bankAccounts = bals
    .filter((b) => b.accountType === "Bank" && b.active)
    .map((b) => ({ qboAccountId: b.qboAccountId, name: b.name }));
  const balByAccount = new Map(bals.map((b) => [b.qboAccountId, -b.netCents]));

  return (
    <div className="space-y-10">
      {loans.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No loans tracked yet. Add your mortgage below to generate an amortization schedule and
          (later) auto-post payment splits.
        </p>
      )}

      {loans.map((loan) => {
        const ledgerBal = loan.liabilityAccountQboId ? (balByAccount.get(loan.liabilityAccountQboId) ?? 0) : 0;
        const today = new Date().toISOString().slice(0, 10);

        const sum = (() => {
          if (loan.interestOnly) return null;
          if (loan.remainingTermMonths != null && loan.annualRateBps != null && ledgerBal > 0) {
            return summarizeFromNow({
              currentBalanceCents: ledgerBal,
              annualRateBps: loan.annualRateBps,
              remainingTermMonths: loan.remainingTermMonths,
              monthlyPaymentCents: loan.monthlyPaymentCents,
              monthlyEscrowCents: loan.monthlyEscrowCents,
              asOfDate: today,
            });
          }
          if (loan.originalPrincipalCents != null && loan.annualRateBps != null && loan.termMonths != null && loan.firstPaymentDate) {
            return summarize({
              originalPrincipalCents: loan.originalPrincipalCents,
              annualRateBps: loan.annualRateBps,
              termMonths: loan.termMonths,
              firstPaymentDate: loan.firstPaymentDate,
              monthlyPaymentCents: loan.monthlyPaymentCents,
              monthlyEscrowCents: loan.monthlyEscrowCents,
            });
          }
          return null;
        })();

        return (
          <Section
            key={loan.id}
            title={loan.name}
            description={loan.lender ?? "—"}
            action={
              <Link href={`/ledger/${entityId}/loans/${loan.id}`} className="text-muted-foreground hover:text-evergreen">
                Schedule &amp; edit →
              </Link>
            }
          >
            <div className="grid grid-cols-2 gap-x-10 gap-y-4 sm:grid-cols-3">
              {ledgerBal > 0 && <Stat label="Current balance" value={<Money cents={ledgerBal} />} />}
              {loan.annualRateBps != null && <Stat label="Rate" value={`${(loan.annualRateBps / 100).toFixed(3)}%`} />}
              {loan.remainingTermMonths != null ? (
                <Stat label="Remaining term" value={`${(loan.remainingTermMonths / 12).toFixed(1)} yrs`} />
              ) : loan.termMonths != null ? (
                <Stat label="Full term" value={`${(loan.termMonths / 12).toFixed(0)} yrs`} />
              ) : null}
              {sum && <Stat label="Monthly P&I" value={<Money cents={sum.paymentCents} />} />}
              {loan.monthlyEscrowCents > 0 && <Stat label="Monthly escrow" value={<Money cents={loan.monthlyEscrowCents} />} />}
              {sum && <Stat label="Payoff date" value={sum.payoffDate ?? "—"} />}
              {sum && <Stat label="Remaining interest" value={<Money cents={sum.totalInterestCents} />} />}
            </div>
            {loan.notes && <p className="mt-3 text-sm text-muted-foreground">{loan.notes}</p>}
          </Section>
        );
      })}

      {!readOnly && (
        <Section
          title="Add a loan"
          description="Enter the terms to generate an amortization schedule; the liability engine posts payment splits from the Plaid feed."
        >
          <LoanForm entityId={entityId} liabilityAccounts={liabilityAccounts} interestAccounts={interestAccounts} bankAccounts={bankAccounts} />
        </Section>
      )}
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

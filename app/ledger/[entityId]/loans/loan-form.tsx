import { saveLoan } from "./actions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Loan } from "@/lib/ledger/loans";

interface AccountOpt {
  qboAccountId: string;
  name: string;
}

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <label className="block text-sm">
    <span className="text-muted-foreground">{label}</span>
    {hint && <span className="ml-1 text-xs text-faint">({hint})</span>}
    <div className="mt-1">{children}</div>
  </label>
);

/**
 * Add/edit loan terms.
 *
 * Only the "current-state" fields are required — rate + remaining term.
 * The system computes principal paydown automatically from the GL, so you
 * never need to enter the original principal or origination date.
 *
 * The "Advanced" section exposes the legacy full-terms fields for entities
 * that were configured before this simpler approach was added.
 */
export function LoanForm({
  entityId,
  liabilityAccounts,
  interestAccounts,
  bankAccounts,
  loan,
}: {
  entityId: string;
  liabilityAccounts: AccountOpt[];
  interestAccounts: AccountOpt[];
  /** Bank accounts — the funding side of auto-recognition. */
  bankAccounts: AccountOpt[];
  loan?: Loan;
}) {
  const hasLegacyData =
    loan?.originalPrincipalCents != null ||
    loan?.termMonths != null ||
    loan?.firstPaymentDate != null;

  return (
    <form action={saveLoan} className="space-y-6">
      <input type="hidden" name="entityId" value={entityId} />
      {loan && <input type="hidden" name="loanId" value={loan.id} />}

      {/* ── Core info ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Loan label">
          <Input name="name" defaultValue={loan?.name ?? "Mortgage"} required />
        </Field>
        <Field label="Lender" hint="optional">
          <Input name="lender" defaultValue={loan?.lender ?? ""} placeholder="e.g. United Wholesale" />
        </Field>

        <Field label="Mortgage payable account">
          <select
            name="liabilityAccountQboId"
            defaultValue={loan?.liabilityAccountQboId ?? ""}
            className="h-9 w-full rounded-md border border-hair bg-card px-3 text-sm"
          >
            <option value="">— none —</option>
            {liabilityAccounts.map((a) => (
              <option key={a.qboAccountId} value={a.qboAccountId}>{a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Interest expense account" hint="optional">
          <select
            name="interestAccountQboId"
            defaultValue={loan?.interestAccountQboId ?? ""}
            className="h-9 w-full rounded-md border border-hair bg-card px-3 text-sm"
          >
            <option value="">— none —</option>
            {interestAccounts.map((a) => (
              <option key={a.qboAccountId} value={a.qboAccountId}>{a.name}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* ── Current terms (for payoff schedule) ── */}
      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Current terms — for payoff date &amp; amortization schedule
        </p>
        <p className="mb-3 text-xs text-faint">
          Enter the rate and time remaining as of today. Leave blank if you only need
          paydown tracking (which comes from the GL automatically).
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Current interest rate (%)" hint="optional">
            <Input
              name="annualRatePct"
              inputMode="decimal"
              defaultValue={loan?.annualRateBps != null ? (loan.annualRateBps / 100).toString() : ""}
              placeholder="6.5"
            />
          </Field>
          <Field label="Remaining term (years)" hint="optional — as of today">
            <Input
              name="remainingTermYears"
              inputMode="decimal"
              defaultValue={
                loan?.remainingTermMonths != null
                  ? (loan.remainingTermMonths / 12).toFixed(1)
                  : ""
              }
              placeholder="26.5"
            />
          </Field>
          <Field label="Monthly P&I ($)" hint="blank = compute from rate + term">
            <Input
              name="monthlyPayment"
              inputMode="decimal"
              defaultValue={loan?.monthlyPaymentCents != null ? (loan.monthlyPaymentCents / 100).toFixed(2) : ""}
              placeholder="auto"
            />
          </Field>
          <Field label="Monthly escrow ($)" hint="optional">
            <Input
              name="monthlyEscrow"
              inputMode="decimal"
              defaultValue={loan ? (loan.monthlyEscrowCents / 100).toFixed(2) : "0.00"}
            />
          </Field>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="interestOnly"
            defaultChecked={loan?.interestOnly ?? false}
            className="accent-evergreen"
          />
          <span className="text-muted-foreground">
            Interest-only or 0%-interest deferral (no amortizing principal)
          </span>
        </label>
      </div>

      {/* ── Auto-recognition (the liability engine) ── */}
      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Auto-recognition — post payment splits automatically
        </p>
        <p className="mb-3 text-xs text-faint">
          With a funding account and expected payment set, drafts within ~15% of
          the expected amount auto-post as principal / interest / escrow (interest
          estimated from the ledger balance × rate; escrow expensed monthly and
          trued up at year end). Leave the expected payment blank to keep this
          loan&apos;s payments in Review.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Paid from (bank account)">
            <select
              name="fundingAccountQboId"
              defaultValue={loan?.fundingAccountQboId ?? ""}
              className="h-9 w-full rounded-md border border-hair bg-card px-3 text-sm"
            >
              <option value="">— none (recognition off) —</option>
              {bankAccounts.map((a) => (
                <option key={a.qboAccountId} value={a.qboAccountId}>{a.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Expected monthly draft ($)" hint="P&I + escrow — the recognition band's center">
            <Input
              name="expectedPayment"
              inputMode="decimal"
              defaultValue={
                loan?.expectedPaymentCents != null
                  ? (loan.expectedPaymentCents / 100).toFixed(2)
                  : ""
              }
              placeholder="6497.57"
            />
          </Field>
          <Field label="Escrow expenses to" hint="taxes & insurance — adjusted at year end">
            <select
              name="escrowAccountQboId"
              defaultValue={loan?.escrowAccountQboId ?? ""}
              className="h-9 w-full rounded-md border border-hair bg-card px-3 text-sm"
            >
              <option value="">— none (no escrow leg) —</option>
              {interestAccounts.map((a) => (
                <option key={a.qboAccountId} value={a.qboAccountId}>{a.name}</option>
              ))}
            </select>
          </Field>
        </div>
        {loan && loan.recognizedCount > 0 && (
          <p className="mt-3 text-xs text-faint">
            Recognized {loan.recognizedCount} payment{loan.recognizedCount === 1 ? "" : "s"}
            {loan.lastRecognizedDate ? ` (last ${loan.lastRecognizedDate})` : ""}
            {loan.payeeAliases.length
              ? ` · known servicer descriptors: ${loan.payeeAliases.join(", ")}`
              : ""}
          </p>
        )}
      </div>

      {/* ── Notes ── */}
      <Field label="Notes" hint="optional — e.g. forbearance deferral, 0% rate, 30-yr payback">
        <Input name="notes" defaultValue={loan?.notes ?? ""} />
      </Field>

      {/* ── Legacy fields (only shown when editing a loan that has them) ── */}
      {hasLegacyData && (
        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Legacy fields (original principal, full term, origination date)
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Original principal ($)" hint="legacy — leave blank for new loans">
              <Input
                name="originalPrincipal"
                inputMode="decimal"
                defaultValue={loan?.originalPrincipalCents != null ? (loan.originalPrincipalCents / 100).toFixed(2) : ""}
                placeholder="429000.00"
              />
            </Field>
            <Field label="Full term (years)" hint="legacy">
              <Input
                name="termYears"
                inputMode="decimal"
                defaultValue={loan?.termMonths != null ? (loan.termMonths / 12).toString() : ""}
                placeholder="30"
              />
            </Field>
            <Field label="First payment date" hint="legacy">
              <Input type="date" name="firstPaymentDate" defaultValue={loan?.firstPaymentDate ?? ""} />
            </Field>
            <Field label="Origination date" hint="legacy — optional">
              <Input type="date" name="startDate" defaultValue={loan?.startDate ?? ""} />
            </Field>
          </div>
        </details>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit">{loan ? "Save changes" : "Add loan terms"}</Button>
      </div>
    </form>
  );
}

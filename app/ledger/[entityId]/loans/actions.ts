"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { upsertLoan, deleteLoan, type LoanInput } from "@/lib/ledger/loans";
import { assertEntityWrite } from "@/lib/ledger/access";
import { logAudit } from "@/lib/ledger/audit";
import { str, floatOrNull } from "@/lib/ledger/forms";

function toCents(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim().replace(/[$,]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function toCentsRequired(v: FormDataEntryValue | null): number {
  return toCents(v) ?? 0;
}

export async function saveLoan(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityWrite(entityId);
  const loanId = formData.get("loanId") ? String(formData.get("loanId")) : undefined;

  const ratePct    = floatOrNull(formData.get("annualRatePct"));
  const remYears   = floatOrNull(formData.get("remainingTermYears"));
  const termYears  = floatOrNull(formData.get("termYears"));
  const origPrin   = toCents(formData.get("originalPrincipal"));

  const input: LoanInput = {
    name: str(formData.get("name")) ?? "Mortgage",
    lender: str(formData.get("lender")),
    liabilityAccountQboId: str(formData.get("liabilityAccountQboId")),
    interestAccountQboId: str(formData.get("interestAccountQboId")),
    // Liability-engine links: where the escrow LEG expenses to, and which bank
    // account pays the loan (the recognizer's structural identity anchor).
    escrowAccountQboId: str(formData.get("escrowAccountQboId")),
    fundingAccountQboId: str(formData.get("fundingAccountQboId")),
    // The engine's on-switch: the current full draft. Null = payments for this
    // loan land in Review instead of auto-posting.
    expectedPaymentCents: toCents(formData.get("expectedPayment")),

    // Current-state fields (preferred)
    annualRateBps: ratePct != null ? Math.round(ratePct * 100) : null,
    remainingTermMonths: remYears != null ? Math.round(remYears * 12) : null,
    rateAsOfDate: remYears != null || ratePct != null ? new Date().toISOString().slice(0, 10) : null,

    // Legacy fields (only written if form included them)
    originalPrincipalCents: origPrin,
    termMonths: termYears != null ? Math.round(termYears * 12) : null,
    startDate: str(formData.get("startDate")),
    firstPaymentDate: str(formData.get("firstPaymentDate")),

    monthlyPaymentCents: toCents(formData.get("monthlyPayment")),
    monthlyEscrowCents: toCentsRequired(formData.get("monthlyEscrow")),
    interestOnly: formData.get("interestOnly") != null,
    notes: str(formData.get("notes")),
  };

  await upsertLoan(entityId, input, loanId);
  // Before redirect() (which throws): record the change to the loan/mortgage
  // configuration — this drives the liability engine's principal/interest/escrow
  // splits, so it's review-worthy even though it posts no journal entry itself.
  await logAudit({
    entityId,
    actionType: loanId ? "update_loan" : "create_loan",
    objectTable: "bk_loans",
    objectId: loanId ?? null,
    description: `${loanId ? "Updated" : "Created"} loan "${input.name}"${input.expectedPaymentCents != null ? " (auto-split enabled)" : ""}`,
    after: {
      name: input.name,
      annualRateBps: input.annualRateBps,
      expectedPaymentCents: input.expectedPaymentCents,
      monthlyEscrowCents: input.monthlyEscrowCents,
      interestOnly: input.interestOnly,
    },
  });
  revalidatePath(`/ledger/${entityId}/loans`);
  revalidatePath(`/ledger/${entityId}`);
  redirect(`/ledger/${entityId}/loans`);
}

export async function removeLoan(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityWrite(entityId);
  const loanId = String(formData.get("loanId"));
  await deleteLoan(entityId, loanId);
  await logAudit({
    entityId,
    actionType: "delete_loan",
    objectTable: "bk_loans",
    objectId: loanId,
    description: "Deleted a loan configuration",
  });
  revalidatePath(`/ledger/${entityId}/loans`);
  revalidatePath(`/ledger/${entityId}`);
  redirect(`/ledger/${entityId}/loans`);
}

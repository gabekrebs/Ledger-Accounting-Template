"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { upsertLoan, deleteLoan, type LoanInput } from "@/lib/ledger/loans";
import { assertEntityAccess } from "@/lib/ledger/access";

function toCents(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim().replace(/[$,]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function toCentsRequired(v: FormDataEntryValue | null): number {
  return toCents(v) ?? 0;
}
function str(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
function floatOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export async function saveLoan(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
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
  revalidatePath(`/ledger/${entityId}/loans`);
  revalidatePath(`/ledger/${entityId}`);
  redirect(`/ledger/${entityId}/loans`);
}

export async function removeLoan(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const loanId = String(formData.get("loanId"));
  await deleteLoan(entityId, loanId);
  revalidatePath(`/ledger/${entityId}/loans`);
  revalidatePath(`/ledger/${entityId}`);
  redirect(`/ledger/${entityId}/loans`);
}

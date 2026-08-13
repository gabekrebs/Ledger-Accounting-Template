"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { unpostTransaction } from "./actions";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";

export type AutoPostedTxn = {
  txnId: string;
  txnDate: string;
  label: string;
  amountCents: number;
  categoryLabel: string;
};

/**
 * One auto-posted row with an Undo. Undo reverses the journal entry and returns
 * the transaction to the review inbox — the human safety check that makes
 * unattended auto-posting acceptable.
 */
export function AutoPostedRow({
  entityId,
  txn,
  readOnly = false,
}: {
  entityId: string;
  txn: AutoPostedTxn;
  /** Read-only viewer: no Undo (unpost is a ledger write). */
  readOnly?: boolean;
}) {
  const [busy, start] = useTransition();
  const router = useRouter();

  function undo() {
    const fd = new FormData();
    fd.set("entityId", entityId);
    fd.set("txnId", txn.txnId);
    start(async () => {
      const res = await unpostTransaction(fd);
      if (res?.ok) {
        toast.success("Reversed — back in the review inbox");
        router.refresh();
      } else {
        toast.error(res?.error ?? "Could not undo");
      }
    });
  }

  return (
    <tr className="border-b border-hair/60">
      <td className="whitespace-nowrap py-3 font-mono tabular-nums text-muted-foreground">
        {txn.txnDate}
      </td>
      <td className="max-w-[14rem] py-3">
        <div className="truncate">{txn.label}</div>
      </td>
      <td className="py-3 text-xs text-muted-foreground">{txn.categoryLabel}</td>
      <td className="py-3 text-right">
        <Money cents={-txn.amountCents} tone="auto" />
      </td>
      <td className="py-3 pl-3 text-right">
        {!readOnly && (
          <Button size="sm" variant="ghost" onClick={undo} disabled={busy}>
            {busy ? "Undoing…" : "Undo"}
          </Button>
        )}
      </td>
    </tr>
  );
}

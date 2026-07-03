"use client";

import { useActionState } from "react";
import { createShareLinkAction } from "./actions";

/** Generates a 7-day signed share link for a CPA, shown inline to copy. */
export function ShareButton({ entityId, docId }: { entityId: string; docId: string }) {
  const [state, action, pending] = useActionState(createShareLinkAction, null);
  const mine = state?.docId === docId;
  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="docId" value={docId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs text-muted-foreground hover:text-evergreen disabled:opacity-50"
      >
        {pending ? "Creating…" : "Share (7-day link)"}
      </button>
      {mine && state?.url && (
        <input
          readOnly
          value={state.url}
          onFocus={(e) => e.currentTarget.select()}
          className="w-56 rounded border border-hair bg-card px-1.5 py-0.5 font-mono text-[10px]"
        />
      )}
      {mine && state?.error && <span className="text-[10px] text-oxblood">{state.error}</span>}
    </form>
  );
}

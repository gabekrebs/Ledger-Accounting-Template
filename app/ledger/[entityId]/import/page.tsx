"use client";

import { useCallback, useRef, useState, useTransition, useEffect } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { WaveBalancesPreview, BalanceAccount } from "@/lib/ledger/wave-balance-import";
import type { WavePreview, SampleEntry } from "@/lib/ledger/wave-import";
import type { BalanceHealthResult } from "@/lib/ledger/balance-health";
import {
  getImportHistory,
  checkHealth,
  fixHealth,
  getImportedAccounts,
  type ImportRecord,
} from "./actions";
import {
  bulkSetAccountActivityAction,
} from "../accounts/actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(iso: string) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Drop-zone
// ---------------------------------------------------------------------------

function DropZone({
  label, hint, loaded, onFile, disabled,
}: {
  label: string; hint: string; loaded: boolean;
  onFile: (text: string, name: string) => void; disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const readFile = useCallback((file: File) => {
    file.text().then((t) => onFile(t, file.name));
  }, [onFile]);

  return (
    <div
      className={`flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors
        ${dragging ? "border-evergreen/60 bg-evergreen/5" : "border-border hover:border-muted-foreground/40"}
        ${disabled ? "pointer-events-none opacity-50" : ""}`}
      onClick={() => ref.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) readFile(f); }}
    >
      <svg className="h-7 w-7 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
      </svg>
      <div>
        <p className="text-sm font-medium">
          {loaded ? "File loaded — drop another to replace" : label}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <input ref={ref} type="file" accept=".csv,text/csv" className="sr-only"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} disabled={disabled} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline alert boxes
// ---------------------------------------------------------------------------

function ErrorBox({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 space-y-1">
      <p className="text-sm font-medium text-destructive">Cannot import</p>
      {messages.map((m, i) => <p key={i} className="text-sm text-destructive/80">{m}</p>)}
    </div>
  );
}

function WarnBox({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <div className="rounded-lg border border-amber-300/60 bg-amber-50/50 dark:bg-amber-900/10 p-4 space-y-1">
      <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Notices</p>
      {messages.map((m, i) => <p key={i} className="text-sm text-amber-700/80 dark:text-amber-400/80">{m}</p>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account Balances preview card
// ---------------------------------------------------------------------------

function BalancesPreviewCard({ preview }: { preview: WaveBalancesPreview }) {
  const hasNetIncome = preview.netIncomeCents !== 0;
  return (
    <div className="space-y-4">
      <ErrorBox messages={preview.errors} />
      <WarnBox messages={preview.warnings} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "As of date", value: fmtDate(preview.asOfDate) },
          { label: "Accounts", value: preview.accounts.length.toLocaleString() },
          { label: "Total debits", value: fmt(preview.totalDebitCents) },
          {
            label: "Residual",
            value: preview.residualCents === 0 ? "$0.00 ✓" : fmt(preview.residualCents),
            err: preview.residualCents !== 0,
          },
        ].map(({ label, value, err }) => (
          <div key={label} className={`rounded-lg border p-3 ${err ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/40"}`}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`mt-0.5 text-sm font-medium tabular-nums ${err ? "text-destructive" : ""}`}>{value}</p>
          </div>
        ))}
      </div>

      {hasNetIncome && (
        <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2">
          <p className="text-xs font-medium text-foreground">
            {preview.netIncomeCents < 0 ? "Net loss" : "Net income"} added as &ldquo;Historical Net Income&rdquo; equity
          </p>
          {(preview.totalIncomeCents > 0 || preview.totalExpenseCents > 0) ? (
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div>
                <p className="text-muted-foreground">All-time Income</p>
                <p className="mt-0.5 tabular-nums font-medium">{fmt(preview.totalIncomeCents)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">All-time Expenses</p>
                <p className="mt-0.5 tabular-nums font-medium">{fmt(preview.totalExpenseCents)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Net income</p>
                <p className={`mt-0.5 tabular-nums font-medium ${preview.netIncomeCents < 0 ? "text-destructive" : "text-green-700 dark:text-green-400"}`}>
                  {fmt(preview.netIncomeCents)}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              The Wave Account Balances export does not include P&amp;L detail.
              A <span className="font-medium text-foreground">{fmt(Math.abs(preview.netIncomeCents))}</span>{" "}
              {preview.netIncomeCents < 0 ? "net loss" : "net gain"} was derived from the balance-sheet residual
              and posted as a single Historical Net Income equity line.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Opening balance entries use balance-sheet accounts only.
            Individual income &amp; expense history comes from the Account Transactions import (Step 1).
          </p>
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="px-4 py-2 text-left text-xs text-muted-foreground font-medium">Account</th>
              <th className="px-4 py-2 text-left text-xs text-muted-foreground font-medium">Section</th>
              <th className="px-4 py-2 text-right text-xs text-muted-foreground font-medium">Balance</th>
              <th className="px-4 py-2 text-right text-xs text-muted-foreground font-medium">Entry Side</th>
            </tr>
          </thead>
          <tbody>
            {preview.accounts.map((a: BalanceAccount, i: number) => (
              <tr key={i} className={`border-b border-border last:border-0 ${a.name === "Historical Net Income" ? "bg-muted/30" : ""}`}>
                <td className="px-4 py-2 text-sm font-medium">
                  {a.name}
                  {a.name === "Historical Net Income" && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">(rolled up)</span>
                  )}
                </td>
                <td className="px-4 py-2 text-sm text-muted-foreground">{a.section}</td>
                <td className="px-4 py-2 text-right tabular-nums font-mono text-xs">{fmt(a.endingBalanceCents)}</td>
                <td className="px-4 py-2 text-right">
                  <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium
                    ${a.side === "debit"
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300"
                      : "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300"}`}>
                    {a.side}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview.residualCents === 0 && preview.errors.length === 0 && (
        <p className="text-sm text-green-700 dark:text-green-400">
          ✓ Trial balance is balanced — entry will post cleanly.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account Transactions preview card
// ---------------------------------------------------------------------------

function TxnPreviewCard({ preview }: { preview: WavePreview }) {
  return (
    <div className="space-y-4">
      <ErrorBox messages={preview.errors} />
      <WarnBox messages={preview.warnings} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Entries", value: preview.entries.toLocaleString() },
          { label: "Accounts", value: preview.accounts.toLocaleString() },
          { label: "Date range", value: preview.dateMin ? `${preview.dateMin} – ${preview.dateMax}` : "—" },
          { label: "Total debits", value: fmt(preview.totalDebitCents) },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-0.5 text-sm font-medium tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-border px-2.5 py-1 text-muted-foreground">
          {preview.matchedByDescription.toLocaleString()} matched by description
        </span>
        {preview.matchedByAmount > 0 && (
          <span className="rounded-full border border-border px-2.5 py-1 text-muted-foreground">
            {preview.matchedByAmount.toLocaleString()} matched by amount
          </span>
        )}
        {preview.inferred > 0 && (
          <span className="rounded-full border border-amber-300/60 bg-amber-50/50 dark:bg-amber-900/10 px-2.5 py-1 text-amber-700 dark:text-amber-400">
            {preview.inferred.toLocaleString()} inferred (suspense)
          </span>
        )}
      </div>

      {preview.sampleEntries.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="border-b border-border bg-muted/40 px-4 py-2">
            <span className="text-xs text-muted-foreground font-medium">
              First {preview.sampleEntries.length} of {preview.entries.toLocaleString()} entries
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="px-3 py-2 text-left text-xs text-muted-foreground font-medium w-24">Date</th>
                  <th className="px-3 py-2 text-left text-xs text-muted-foreground font-medium">Description</th>
                  <th className="px-3 py-2 text-left text-xs text-muted-foreground font-medium hidden lg:table-cell">Debit account</th>
                  <th className="px-3 py-2 text-left text-xs text-muted-foreground font-medium hidden lg:table-cell">Credit account</th>
                  <th className="px-3 py-2 text-right text-xs text-muted-foreground font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.sampleEntries.map((e: SampleEntry, i: number) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{e.date}</td>
                    <td className="px-3 py-2 text-xs max-w-xs truncate" title={e.description}>{e.description}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground hidden lg:table-cell max-w-[160px] truncate" title={e.debitAccount}>{e.debitAccount}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground hidden lg:table-cell max-w-[160px] truncate" title={e.creditAccount}>{e.creditAccount}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-mono text-xs">{fmt(e.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview.residualCents === 0 && preview.errors.length === 0 && (
        <p className="text-sm text-green-700 dark:text-green-400">
          ✓ Books balance — accounting equation residual is $0.00.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import history table
// ---------------------------------------------------------------------------

function ImportHistoryTable({ records }: { records: ImportRecord[] }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">Import history</h3>
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="px-4 py-2 text-left text-xs text-muted-foreground font-medium">Imported</th>
              <th className="px-4 py-2 text-left text-xs text-muted-foreground font-medium">Type</th>
              <th className="px-4 py-2 text-right text-xs text-muted-foreground font-medium">Inserted</th>
              <th className="px-4 py-2 text-right text-xs text-muted-foreground font-medium">Skipped</th>
              <th className="px-4 py-2 text-left text-xs text-muted-foreground font-medium hidden sm:table-cell">Notes</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">{fmtDate(r.importedAt)}</td>
                <td className="px-4 py-2">
                  <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium
                    ${r.importType === "balances"
                      ? "bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-300"
                      : "bg-sky-50 text-sky-700 dark:bg-sky-900/20 dark:text-sky-300"}`}>
                    {r.importType === "balances" ? "Balances" : "Transactions"}
                  </span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-xs">{r.entriesInserted.toLocaleString()}</td>
                <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">{r.entriesSkipped.toLocaleString()}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground hidden sm:table-cell">{r.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard step indicator
// ---------------------------------------------------------------------------

type WizardStep = "txn" | "balq" | "bal" | "done";

const WIZARD_STEPS = [
  { key: "txn" as WizardStep, label: "Transactions" },
  { key: "balq" as WizardStep, label: "Opening balances" },
  { key: "done" as WizardStep, label: "Done" },
];

function StepBar({ step }: { step: WizardStep }) {
  const idx = step === "txn" ? 0 : step === "done" ? 2 : 1;
  return (
    <div className="flex items-center">
      {WIZARD_STEPS.map(({ key, label }, i) => (
        <div key={key} className="flex items-center">
          <div className={`flex items-center gap-2 ${i === idx ? "text-foreground" : "text-muted-foreground/60"}`}>
            <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold
              ${i < idx
                ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                : i === idx
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground/60"}`}>
              {i < idx ? "✓" : i + 1}
            </span>
            <span className="text-sm">{label}</span>
          </div>
          {i < WIZARD_STEPS.length - 1 && (
            <div className={`mx-3 h-px w-10 ${i < idx ? "bg-green-300 dark:bg-green-700" : "bg-border"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

function initialStep(history: ImportRecord[]): WizardStep {
  const hasTxns = history.some((r) => r.importType === "transactions");
  const hasBals = history.some((r) => r.importType === "balances");
  if (hasTxns && hasBals) return "done";
  if (hasTxns) return "balq";
  return "txn";
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function WaveImportPage() {
  const params = useParams<{ entityId: string }>();
  const entityId = params.entityId;

  const [history, setHistory] = useState<ImportRecord[]>([]);
  const [step, setStep] = useState<WizardStep>("txn");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Step 1 — Transactions
  const [txnCsv, setTxnCsv] = useState<string | null>(null);
  const [txnFileName, setTxnFileName] = useState("");
  const [txnPreview, setTxnPreview] = useState<{ ok: boolean; error?: string; preview?: WavePreview } | null>(null);
  const [txnResult, setTxnResult] = useState<{ inserted: number; dateMin: string; dateMax: string } | null>(null);
  const [txnError, setTxnError] = useState<string | null>(null);
  const [txnPending, startTxn] = useTransition();

  // Activity tagging (after transactions import)
  const [activityAccounts, setActivityAccounts] = useState<
    { id: string; name: string; classification: string; activity: string }[]
  >([]);
  const [activitySelected, setActivitySelected] = useState<Set<string>>(new Set());
  const [activityCustom, setActivityCustom] = useState("");
  const [activitySaving, setActivitySaving] = useState(false);
  const [activityDone, setActivityDone] = useState(false);

  // Step 2b — Balances
  const [balCsv, setBalCsv] = useState<string | null>(null);
  const [balFileName, setBalFileName] = useState("");
  const [balPreview, setBalPreview] = useState<{ ok: boolean; error?: string; preview?: WaveBalancesPreview } | null>(null);
  const [balResult, setBalResult] = useState<{ inserted: number; skipped: number; asOfDate: string } | null>(null);
  const [balError, setBalError] = useState<string | null>(null);
  const [balPending, startBal] = useTransition();

  // Health check — auto-runs after balances commit. "Checking" is DERIVED:
  // a committed result with no issues-answer and no error yet means the check
  // is in flight (the commit handler resets both, the effect below fetches).
  const [healthIssues, setHealthIssues] = useState<BalanceHealthResult | null>(null);
  const [healthFixing, setHealthFixing] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const healthChecking = !!balResult && healthIssues === null && !healthError;

  const refreshHistory = useCallback(
    () => getImportHistory(entityId).then(setHistory),
    [entityId]
  );

  useEffect(() => {
    getImportHistory(entityId).then((h) => {
      setHistory(h);
      setStep(initialStep(h));
      setHistoryLoaded(true);
    });
  }, [entityId]);

  // Auto-run health check whenever balances are freshly committed this session.
  // Fetch-then-set only — the transient checking/error resets happen in
  // handleBalCommit (the event that produces a new balResult).
  useEffect(() => {
    if (!balResult) return;
    let canceled = false;
    checkHealth(entityId)
      .then((issues) => { if (!canceled) setHealthIssues(issues); })
      .catch(() => { if (!canceled) setHealthError("Health check failed — you can continue anyway."); });
    return () => { canceled = true; };
  }, [balResult, entityId]);

  async function waveApi(action: string, csv: string) {
    const res = await fetch("/api/wave-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, entityId, csv }),
    });
    return res.json();
  }

  function handleTxnFile(text: string, name: string) {
    setTxnCsv(text); setTxnFileName(name);
    setTxnPreview(null); setTxnError(null);
    startTxn(async () => {
      const r = await waveApi("preview-txn", text);
      setTxnPreview(r);
    });
  }

  function handleTxnCommit() {
    if (!txnCsv) return;
    setTxnError(null);
    startTxn(async () => {
      const r = await waveApi("commit-txn", txnCsv);
      if (!r.ok) { setTxnError(r.error); return; }
      setTxnResult({ inserted: r.inserted, dateMin: r.dateMin, dateMax: r.dateMax });
      await refreshHistory();
      // Load accounts for activity tagging
      const accts = await getImportedAccounts(entityId);
      setActivityAccounts(accts);
    });
  }

  function handleBalFile(text: string, name: string) {
    setBalCsv(text); setBalFileName(name);
    setBalPreview(null); setBalError(null);
    startBal(async () => {
      const r = await waveApi("preview-bal", text);
      setBalPreview(r);
    });
  }

  function handleBalCommit() {
    if (!balCsv) return;
    setBalError(null);
    startBal(async () => {
      const r = await waveApi("commit-bal", balCsv);
      if (!r.ok) { setBalError(r.error); return; }
      // Fresh commit → clear the previous health answer so the derived
      // "checking" state flips on while the effect re-runs the check.
      setHealthIssues(null);
      setHealthError(null);
      setBalResult({ inserted: r.inserted, skipped: r.skipped, asOfDate: r.asOfDate });
      await refreshHistory();
    });
  }

  async function handleFixHealth() {
    setHealthFixing(true);
    setHealthError(null);
    try {
      await fixHealth(entityId);
      const issues = await checkHealth(entityId);
      setHealthIssues(issues);
    } catch {
      setHealthError("Fix failed — try again, or continue anyway.");
    } finally {
      setHealthFixing(false);
    }
  }

  const healthClean = healthIssues !== null && !healthIssues.hasIssues;
  const latestTxnImport = history.find((r) => r.importType === "transactions");
  const latestBalImport = history.find((r) => r.importType === "balances");

  if (!historyLoaded) {
    return <div className="py-8 text-sm text-muted-foreground animate-pulse">Loading…</div>;
  }

  return (
    <div className="space-y-8 py-2">
      <StepBar step={step} />

      {/* ── Step 1: Transactions ── */}
      {step === "txn" && (
        <section className="space-y-5 rounded-xl border border-border p-6">
          <div>
            <h3 className="text-sm font-semibold">Import transaction history</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Your full Wave transaction log is the source of truth — all income, expenses, and balance movements.
              In Wave:{" "}
              <span className="font-medium text-foreground">Accounting → Transactions → Export CSV</span>.
              Both &ldquo;Account Transactions&rdquo; and &ldquo;Accounting Transactions&rdquo; formats are supported.
            </p>
          </div>

          {latestTxnImport && !txnResult && (
            <div className="rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800/40 dark:bg-green-900/10 p-4">
              <p className="text-sm font-medium text-green-800 dark:text-green-300">
                ✓ {latestTxnImport.entriesInserted.toLocaleString()} transactions already imported
              </p>
              <p className="mt-0.5 text-xs text-green-700/70 dark:text-green-400/60">
                {latestTxnImport.notes ?? `Imported ${fmtDate(latestTxnImport.importedAt)}`}
              </p>
            </div>
          )}

          {txnResult && (
            <div className="rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800/40 dark:bg-green-900/10 p-4">
              <p className="text-sm font-medium text-green-800 dark:text-green-300">
                ✓ {txnResult.inserted.toLocaleString()} transactions imported
              </p>
              <p className="mt-0.5 text-xs text-green-700/70">{txnResult.dateMin} – {txnResult.dateMax}</p>
            </div>
          )}

          {!txnResult && (
            <>
              <DropZone
                label="Drop Account Transactions CSV, or click to select"
                hint={txnFileName || "Wave Account Transactions export (.csv)"}
                loaded={!!txnCsv}
                onFile={handleTxnFile}
                disabled={txnPending}
              />

              {txnPending && !txnPreview && (
                <p className="text-sm text-muted-foreground animate-pulse">Parsing…</p>
              )}

              {txnPreview && (
                <div className="space-y-4">
                  {txnPreview.ok && txnPreview.preview
                    ? <TxnPreviewCard preview={txnPreview.preview} />
                    : <ErrorBox messages={[txnPreview.error ?? "Parse failed"]} />}
                  <div className="flex items-center gap-3">
                    <Button
                      onClick={handleTxnCommit}
                      disabled={!txnPreview.ok || !!txnPreview.preview?.errors.length || txnPending}
                    >
                      {txnPending ? "Importing…" : `Import ${txnPreview.preview?.entries?.toLocaleString() ?? ""} transactions`}
                    </Button>
                    <button type="button"
                      onClick={() => { setTxnCsv(null); setTxnFileName(""); setTxnPreview(null); setTxnError(null); }}
                      className="text-sm text-muted-foreground hover:text-foreground">
                      Start over
                    </button>
                  </div>
                  {txnError && <p className="text-sm text-destructive">{txnError}</p>}
                </div>
              )}
            </>
          )}

          {/* Activity tagging — appears after import so user can tag non-RE accounts */}
          {txnResult && activityAccounts.length > 0 && !activityDone && (
            <div className="space-y-4 rounded-lg border border-border p-5">
              <div>
                <h4 className="text-sm font-semibold">Tag non-real-estate accounts</h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  All accounts default to &ldquo;Real Estate&rdquo;. Select any accounts that belong
                  to a different business activity (e.g. Vehicle Leasing, Hospitality) and assign them.
                  You can always change this later on the Accounts tab.
                </p>
              </div>

              <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="sticky top-0 border-b border-border bg-muted/60 text-[11px] font-medium uppercase tracking-wide text-faint">
                      <th className="w-8 py-2 pl-3">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-evergreen"
                          checked={activitySelected.size === activityAccounts.length && activityAccounts.length > 0}
                          onChange={(e) => {
                            setActivitySelected(
                              e.target.checked ? new Set(activityAccounts.map((a) => a.id)) : new Set()
                            );
                          }}
                        />
                      </th>
                      <th className="py-2 text-left">Account</th>
                      <th className="py-2 text-left">Type</th>
                      <th className="py-2 pr-3 text-left">Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activityAccounts.map((a) => (
                      <tr key={a.id} className="border-b border-border/60 last:border-0">
                        <td className="py-1.5 pl-3">
                          <input
                            type="checkbox"
                            className="size-3.5 accent-evergreen"
                            checked={activitySelected.has(a.id)}
                            onChange={(e) => {
                              const next = new Set(activitySelected);
                              if (e.target.checked) next.add(a.id);
                              else next.delete(a.id);
                              setActivitySelected(next);
                            }}
                          />
                        </td>
                        <td className="py-1.5 text-sm">{a.name}</td>
                        <td className="py-1.5 text-xs text-muted-foreground capitalize">{a.classification}</td>
                        <td className="py-1.5 pr-3">
                          <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] ${
                            a.activity === "Real Estate"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-amber-200 bg-amber-50 text-amber-700"
                          }`}>
                            {a.activity}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {activitySelected.size > 0 && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const activity = activityCustom.trim();
                    if (!activity) return;
                    setActivitySaving(true);
                    await bulkSetAccountActivityAction({
                      entityId,
                      accountIds: [...activitySelected],
                      activity,
                    });
                    setActivityAccounts((prev) =>
                      prev.map((a) =>
                        activitySelected.has(a.id) ? { ...a, activity } : a
                      )
                    );
                    setActivitySelected(new Set());
                    setActivitySaving(false);
                  }}
                >
                  <span className="text-xs text-muted-foreground">
                    {activitySelected.size} selected →
                  </span>
                  <input
                    value={activityCustom}
                    onChange={(e) => setActivityCustom(e.target.value)}
                    placeholder="Activity name (e.g. Vehicle Leasing)"
                    className="h-7 w-56 rounded-lg border border-hair bg-transparent px-2 text-sm outline-none focus:border-evergreen"
                    list="activity-suggestions"
                  />
                  <datalist id="activity-suggestions">
                    {[...new Set(activityAccounts.map((a) => a.activity))].map((a) => (
                      <option key={a} value={a} />
                    ))}
                    <option value="Vehicle Leasing" />
                    <option value="Hospitality" />
                    <option value="Other" />
                  </datalist>
                  <Button type="submit" disabled={!activityCustom.trim() || activitySaving}>
                    {activitySaving ? "Saving…" : "Assign"}
                  </Button>
                </form>
              )}

              <button
                type="button"
                onClick={() => setActivityDone(true)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {activityAccounts.every((a) => a.activity === "Real Estate")
                  ? "All accounts are real estate — skip"
                  : "Done tagging"}
              </button>
            </div>
          )}

          {(latestTxnImport || txnResult) && (
            <div className="pt-1">
              <Button onClick={() => setStep("balq")}>Continue →</Button>
            </div>
          )}
        </section>
      )}

      {/* ── Step 2a: Opening balances question ── */}
      {step === "balq" && (
        <section className="space-y-5 rounded-xl border border-border p-6">
          <div>
            <h3 className="text-sm font-semibold">Do you need opening balances?</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Opening balances seed account starting positions from before your transaction history begins.
              If your Wave export covers the full life of this company, you can skip this.
            </p>
          </div>

          {latestBalImport ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800/40 dark:bg-green-900/10 p-4">
                <p className="text-sm font-medium text-green-800 dark:text-green-300">
                  ✓ Opening balances already posted
                </p>
                <p className="mt-0.5 text-xs text-green-700/70 dark:text-green-400/60">
                  {latestBalImport.notes ?? `As of ${fmtDate(latestBalImport.periodEnd ?? latestBalImport.importedAt)}`}
                </p>
              </div>
              <Button onClick={() => setStep("done")}>Continue →</Button>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setStep("done")}
                className="rounded-xl border-2 border-border p-5 text-left transition-colors hover:border-muted-foreground/50"
              >
                <p className="text-sm font-semibold">My history is complete</p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  My Wave transactions go back to the beginning of this company — no opening balances needed.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setStep("bal")}
                className="rounded-xl border-2 border-border p-5 text-left transition-colors hover:border-muted-foreground/50"
              >
                <p className="text-sm font-semibold">I need opening balances</p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  My Wave history starts mid-life. I have a Balance Sheet snapshot to seed the starting positions.
                </p>
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── Step 2b: Opening balances upload ── */}
      {step === "bal" && (
        <section className="space-y-5 rounded-xl border border-border p-6">
          <div>
            <h3 className="text-sm font-semibold">Upload opening balances</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              In Wave:{" "}
              <span className="font-medium text-foreground">Reports → Balance Sheet → Export CSV</span>.
              A balance health check runs automatically after import to catch any double-counting.
            </p>
          </div>

          {!balResult ? (
            <>
              <DropZone
                label="Drop Balance Sheet CSV, or click to select"
                hint={balFileName || "Wave Balance Sheet export (.csv)"}
                loaded={!!balCsv}
                onFile={handleBalFile}
                disabled={balPending}
              />

              {balPending && !balPreview && (
                <p className="text-sm text-muted-foreground animate-pulse">Parsing…</p>
              )}

              {balPreview && (
                <div className="space-y-4">
                  {balPreview.ok && balPreview.preview
                    ? <BalancesPreviewCard preview={balPreview.preview} />
                    : <ErrorBox messages={[balPreview.error ?? "Parse failed"]} />}
                  <div className="flex items-center gap-3">
                    <Button
                      onClick={handleBalCommit}
                      disabled={!balPreview.ok || !!balPreview.preview?.errors.length || balPending}
                    >
                      {balPending ? "Posting…" : "Post opening balances"}
                    </Button>
                    <button type="button"
                      onClick={() => { setBalCsv(null); setBalFileName(""); setBalPreview(null); }}
                      className="text-sm text-muted-foreground hover:text-foreground">
                      Start over
                    </button>
                  </div>
                  {balError && <p className="text-sm text-destructive">{balError}</p>}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800/40 dark:bg-green-900/10 p-4">
                <p className="text-sm font-medium text-green-800 dark:text-green-300">
                  ✓ Opening balances posted as of {fmtDate(balResult.asOfDate)}
                </p>
                <p className="mt-0.5 text-xs text-green-700/70">
                  {balResult.inserted > 0
                    ? `${balResult.inserted} accounts posted.`
                    : `All ${balResult.skipped} accounts already posted (skipped).`}
                </p>
              </div>

              {healthChecking && (
                <p className="text-sm text-muted-foreground animate-pulse">Running balance health check…</p>
              )}

              {!healthChecking && healthIssues !== null && (
                healthClean ? (
                  <div className="rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800/40 dark:bg-green-900/10 p-4">
                    <p className="text-sm font-medium text-green-800 dark:text-green-300">
                      ✓ Balance health check passed — no duplicate entries
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3 rounded-lg border border-amber-300/60 bg-amber-50/50 dark:bg-amber-900/10 p-4">
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                      ⚠ {healthIssues.issues.length} opening {healthIssues.issues.length === 1 ? "entry" : "entries"} duplicate your transaction history
                    </p>
                    <p className="text-xs text-amber-700/80 dark:text-amber-400/80">
                      These entries double-count account balances. They can be safely removed — your Account Transactions already carry the full history.
                    </p>
                    <Button variant="outline" onClick={handleFixHealth} disabled={healthFixing}>
                      {healthFixing ? "Removing…" : `Remove ${healthIssues.issues.length} duplicate ${healthIssues.issues.length === 1 ? "entry" : "entries"}`}
                    </Button>
                  </div>
                )
              )}

              {healthError && (
                <p className="text-xs text-muted-foreground">{healthError}</p>
              )}

              {!healthChecking && (healthClean || healthError) && (
                <Button onClick={() => setStep("done")}>Continue →</Button>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Step 3: Done ── */}
      {step === "done" && (
        <section className="space-y-5 rounded-xl border border-border p-6">
          <div>
            <h3 className="text-sm font-semibold text-green-700 dark:text-green-400">✓ Books are ready</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Head to the Overview to see balances, returns, and paydown.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {(latestTxnImport || txnResult) && (
              <div className="rounded-lg border border-border bg-muted/40 p-4">
                <p className="text-xs text-muted-foreground">Transactions</p>
                <p className="mt-0.5 text-sm font-medium">
                  {(txnResult?.inserted ?? latestTxnImport?.entriesInserted ?? 0).toLocaleString()} entries
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {txnResult
                    ? `${txnResult.dateMin} – ${txnResult.dateMax}`
                    : (latestTxnImport?.notes ?? "")}
                </p>
              </div>
            )}
            {(latestBalImport || balResult) && (
              <div className="rounded-lg border border-border bg-muted/40 p-4">
                <p className="text-xs text-muted-foreground">Opening balances</p>
                <p className="mt-0.5 text-sm font-medium">
                  As of {fmtDate(balResult?.asOfDate ?? latestBalImport?.periodEnd ?? latestBalImport?.importedAt ?? "")}
                </p>
                {healthClean && (
                  <p className="mt-0.5 text-xs text-green-700 dark:text-green-400">Health check passed</p>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4 pt-1">
            <a href={`/ledger/${entityId}`}>
              <Button>Go to Overview →</Button>
            </a>
            <a href={`/ledger/${entityId}/loans`}
              className="text-sm text-muted-foreground hover:text-foreground">
              Add loan terms for amortization →
            </a>
          </div>
        </section>
      )}

      {/* Import history — collapsible at bottom */}
      {history.length > 0 && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {showHistory ? "Hide" : "Show"} import history ({history.length} import{history.length !== 1 ? "s" : ""})
          </button>
          {showHistory && <ImportHistoryTable records={history} />}
        </div>
      )}
    </div>
  );
}

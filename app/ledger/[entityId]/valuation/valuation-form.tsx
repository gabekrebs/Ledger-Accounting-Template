"use client";

import { useState, useTransition } from "react";
import { usd } from "@/lib/ledger/format";
import {
  saveMethod,
  saveComponent,
  removeComponent,
  saveManualEstimate,
  runAiEstimate,
} from "./actions";
import {
  chosenEstimate,
  componentChosenCents,
  type ValuationComponent,
  type EstimateSource,
} from "@/lib/ledger/valuation-shared";
import type { ValuationMethod } from "@/lib/ledger/reports";

const inputCls = "h-9 w-full rounded-md border border-hair bg-card px-3 text-sm";

/**
 * Submit a server-action form with visible progress + confirmation. A plain
 * `<form action>` gives zero feedback while the action runs (an AI estimate
 * takes 15–30s), which reads as "the button does nothing".
 */
function useFormSubmit(
  action: (fd: FormData) => Promise<void>,
  opts?: { reset?: boolean }
) {
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  const [, start] = useTransition();
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setPhase("busy");
    start(async () => {
      try {
        await action(fd);
        if (opts?.reset) form.reset();
        setPhase("done");
      } catch {
        setPhase("idle");
      }
    });
  };
  return { onSubmit, busy: phase === "busy", done: phase === "done" };
}
const SOURCE_LABEL: Record<EstimateSource, string> = {
  zillow: "Zillow",
  redfin: "Redfin",
  ai: "AI estimate",
  manual: "Your comp",
};

const METHODS: { value: ValuationMethod; title: string; blurb: string }[] = [
  { value: "income", title: "Income property", blurb: "Worth is driven by the rent it earns. Value = stabilized net operating income ÷ a cap rate you set on the Overview. Apartments, commercial, hospitality." },
  { value: "market", title: "Market value", blurb: "Worth is what comparable property sells for. Add each building or asset and value it from Zillow, Redfin, an AI estimate, or your own comp. Houses & duplexes." },
  { value: "equity_stake", title: "Share of another entity", blurb: "Owns a piece of another entity. Value = that entity's value × the ownership share." },
  { value: "none", title: "No property", blurb: "An operating or holding company with no real estate to value. No appreciation figure is shown on the Overview." },
];

export function ValuationForm(props: {
  entityId: string;
  method: ValuationMethod;
  parentEntityId: string | null;
  ownershipPct: string | null;
  entities: { id: string; name: string }[];
  components: ValuationComponent[];
  marketValueCents: number;
}) {
  const [method, setMethod] = useState<ValuationMethod>(props.method);
  const [parentId, setParentId] = useState(props.parentEntityId ?? "");
  const [pct, setPct] = useState(props.ownershipPct ?? "");
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  function persist(m: ValuationMethod) {
    const fd = new FormData();
    fd.set("entityId", props.entityId);
    fd.set("method", m);
    if (m === "equity_stake") {
      fd.set("parentEntityId", parentId);
      fd.set("ownershipPct", pct);
    }
    setSaved(false);
    start(async () => {
      await saveMethod(fd);
      setSaved(true);
    });
  }

  // Picking a method saves it on the spot — no separate "save" step to forget.
  // A share of another entity needs its parent + % first, so that one saves on
  // its button instead.
  function pick(m: ValuationMethod) {
    setMethod(m);
    if (m !== "equity_stake") persist(m);
  }

  return (
    <div className="space-y-8">
      {/* ── how this entity is valued ─────────────────────────── */}
      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">How is this entity valued?</h3>
          <span className="text-xs text-faint" aria-live="polite">
            {pending ? "Saving…" : saved ? "Saved ✓" : ""}
          </span>
        </div>

        <fieldset className="space-y-2.5">
          {METHODS.map((m) => (
            <label
              key={m.value}
              className={`flex cursor-pointer gap-3 rounded-xl border p-3.5 transition-colors ${
                method === m.value ? "border-evergreen bg-evergreen-soft/40" : "border-hair bg-card hover:border-evergreen/40"
              }`}
            >
              <input type="radio" name="method" value={m.value} checked={method === m.value}
                onChange={() => pick(m.value)} className="mt-0.5 accent-evergreen" />
              <span>
                <span className="block text-sm font-medium">{m.title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{m.blurb}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {method === "equity_stake" && (
          <div className="space-y-3 rounded-xl border border-hair bg-[#FAF8F3] dark:bg-secondary p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-muted-foreground">Owns a share of</span>
                <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={`${inputCls} mt-1`}>
                  <option value="">— select entity —</option>
                  {props.entities.filter((e) => e.id !== props.entityId).map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-muted-foreground">Ownership %</span>
                <input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal"
                  placeholder="25" className={`${inputCls} mt-1`} />
              </label>
            </div>
            <button type="button" onClick={() => persist("equity_stake")} disabled={pending}
              className="h-9 rounded-md bg-evergreen px-4 text-sm font-medium text-white hover:bg-evergreen/90 disabled:opacity-60">
              Save share
            </button>
          </div>
        )}
      </div>

      {/* ── market: the pieces that sum to the value ──────────── */}
      {method === "market" && (
        <div className="space-y-5 border-t border-hair pt-6">
          <div className="flex items-baseline justify-between">
            <div>
              <h3 className="font-serif text-lg font-medium tracking-tight">What it&apos;s worth</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The total is the sum of each piece below — a building, or any other asset like vehicles or land.
              </p>
            </div>
            <span className="text-right text-sm text-muted-foreground">
              Total
              <span className="ml-2 font-serif text-xl font-medium tabular-nums text-foreground">{usd(props.marketValueCents)}</span>
            </span>
          </div>

          {props.components.map((c) => (
            <ComponentCard key={c.id} entityId={props.entityId} component={c} />
          ))}

          {/* add a piece */}
          <AddComponentCard entityId={props.entityId} />

          <p className="text-xs text-faint">
            Zillow &amp; Redfin figures refresh on each valuation-refresh run. The headline for each
            piece is the <span className="font-medium">highest available figure</span> unless you pin
            a specific source under “Edit details”.
          </p>
        </div>
      )}
    </div>
  );
}

function AddComponentCard({ entityId }: { entityId: string }) {
  const add = useFormSubmit(saveComponent, { reset: true });
  return (
          <details className="rounded-xl border border-dashed border-hair">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:text-evergreen">+ Add a building or asset</summary>
            <form onSubmit={add.onSubmit} className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
              <input type="hidden" name="entityId" value={entityId} />
              <Field label="Name">
                <input name="label" placeholder="House — 123 Main St   ·   or “3 trailers”" className={inputCls} required />
              </Field>
              <Field label="Value (optional)">
                <input name="value" inputMode="decimal" placeholder="$750,000" className={inputCls} />
              </Field>
              <Field label="Address (optional)">
                <input name="address" placeholder="123 Main St, Springfield, OR 97400" className={inputCls} />
              </Field>
              <div />
              <Field label="Zillow link (optional)">
                <input name="zillowUrl" placeholder="https://www.zillow.com/homedetails/…" className={inputCls} />
              </Field>
              <Field label="Redfin link (optional)">
                <input name="redfinUrl" placeholder="https://www.redfin.com/OR/Portland/…" className={inputCls} />
              </Field>
              <div className="sm:col-span-2">
                <button type="submit" disabled={add.busy} className="h-9 rounded-md bg-evergreen px-4 text-sm font-medium text-white hover:bg-evergreen/90 disabled:opacity-60">
                  {add.busy ? "Adding…" : "Add"}
                </button>
                <span className="ml-2 text-xs text-faint" aria-live="polite">
                  {add.done
                    ? "Added ✓"
                    : "A house? Paste its Zillow/Redfin links. Anything else (vehicles, land, equipment)? Just give it a name and a value."}
                </span>
              </div>
            </form>
          </details>
  );
}

function ComponentCard({ entityId, component: c }: { entityId: string; component: ValuationComponent }) {
  const [showAi, setShowAi] = useState(false);
  const manual = useFormSubmit(saveManualEstimate, { reset: true });
  const ai = useFormSubmit(runAiEstimate);
  const edit = useFormSubmit(saveComponent);
  const chosen = chosenEstimate(c);
  const sources = c.estimates.map((e) => e.source);
  // Linked listings whose figure hasn't been pulled yet — show them as explicit
  // pending rows so "best of Zillow/Redfin/AI" isn't silently missing a source.
  const unpulled = (["zillow", "redfin"] as const).filter(
    (s) => (s === "zillow" ? c.zillowUrl : c.redfinUrl) && !sources.includes(s)
  );
  // AVM figures already on this structure — the AI estimate anchors off them.
  const aiAnchors = c.estimates
    .filter((e) => e.source === "zillow" || e.source === "redfin")
    .map((e) => SOURCE_LABEL[e.source]);

  return (
    <div className="space-y-4 rounded-2xl border border-hair bg-card p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="font-medium">{c.label}</div>
          {c.address && <div className="text-xs text-muted-foreground">{c.address}</div>}
        </div>
        <div className="text-right">
          {chosen ? (
            <>
              <div className="font-serif text-xl font-medium tabular-nums">{usd(componentChosenCents(c))}</div>
              <div className="text-[11px] uppercase tracking-wide text-faint">
                {SOURCE_LABEL[chosen.source]}{chosen.asOf ? ` · ${chosen.asOf}` : ""}
              </div>
            </>
          ) : (
            <div className="text-sm text-faint">No value yet</div>
          )}
        </div>
      </div>

      {/* every source we have a figure from, headline highlighted */}
      {c.estimates.length > 0 ? (
        <div className="space-y-1.5">
          {c.estimates.map((e) => (
            <div key={e.id} className="flex items-baseline gap-3 text-sm">
              <span className={`w-24 shrink-0 ${e.source === chosen?.source ? "font-medium text-evergreen" : "text-muted-foreground"}`}>
                {SOURCE_LABEL[e.source]}
              </span>
              <span className="tabular-nums">{usd(e.valueCents)}</span>
              {e.asOf && <span className="text-xs text-faint">{e.asOf}</span>}
              {e.reasoning && <span className="text-xs text-faint italic line-clamp-1">— {e.reasoning}</span>}
            </div>
          ))}
          {unpulled.map((s) => (
            <div key={s} className="flex items-baseline gap-3 text-sm">
              <span className="w-24 shrink-0 text-muted-foreground">{SOURCE_LABEL[s]}</span>
              <span className="text-xs italic text-faint">
                linked — no figure pulled yet (fills on the next valuation refresh)
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg bg-[#FAF8F3] dark:bg-secondary px-3 py-2 text-xs text-muted-foreground">
          Enter your own comp below, or run an AI estimate. If you added Zillow/Redfin links, their figures
          will fill in on the next background refresh.
        </p>
      )}

      {/* set a value: your comp (inline) + AI estimate (expandable) */}
      <div className="flex flex-wrap items-end gap-4 border-t border-hair pt-4">
        <form onSubmit={manual.onSubmit} className="flex items-end gap-2">
          <input type="hidden" name="entityId" value={entityId} />
          <input type="hidden" name="componentId" value={c.id} />
          <Field label="Your comp ($)"><input name="value" inputMode="decimal" placeholder="750,000" className={`${inputCls} w-36`} /></Field>
          <button type="submit" disabled={manual.busy} className="h-9 rounded-md border border-hair bg-card px-3 text-sm font-medium hover:border-evergreen disabled:opacity-60">
            {manual.busy ? "Saving…" : "Set"}
          </button>
          {manual.done && <span className="pb-2 text-xs text-evergreen" aria-live="polite">Saved ✓</span>}
        </form>
        <button type="button" onClick={() => setShowAi((v) => !v)}
          className="h-9 rounded-md border border-hair bg-card px-3 text-sm font-medium hover:border-evergreen">
          {showAi ? "Hide AI estimate" : "Estimate with AI"}
        </button>
      </div>

      {showAi && (
        <form onSubmit={ai.onSubmit} className="grid gap-3 rounded-xl border border-hair bg-[#FAF8F3] dark:bg-secondary p-4 sm:grid-cols-3">
          <input type="hidden" name="entityId" value={entityId} />
          <input type="hidden" name="componentId" value={c.id} />
          <Field label="Address"><input name="address" defaultValue={c.address ?? ""} className={inputCls} required /></Field>
          <Field label="Type"><input name="propertyType" defaultValue={c.propertyType ?? ""} placeholder="townhome + studio ADU" className={inputCls} /></Field>
          <Field label="Units"><input name="units" defaultValue={c.units ?? ""} placeholder="2 (3BR up + studio)" className={inputCls} /></Field>
          <Field label="Beds"><input name="beds" defaultValue={c.beds ?? ""} placeholder="3" className={inputCls} /></Field>
          <Field label="Baths"><input name="baths" defaultValue={c.baths ?? ""} placeholder="2" className={inputCls} /></Field>
          <Field label="Sqft"><input name="sqft" defaultValue={c.sqft ?? ""} placeholder="1450" className={inputCls} /></Field>
          <Field label="Gross monthly rent"><input name="monthlyRent" defaultValue={c.monthlyRent ?? ""} placeholder="$4,200" className={inputCls} /></Field>
          <Field label="Condition"><input name="condition" defaultValue={c.condition ?? ""} placeholder="new build 2023" className={inputCls} /></Field>
          <Field label="Notes / known comps"><input name="aiNotes" defaultValue={c.factsNote ?? ""} placeholder="Alberta Arts, comp sold $640k" className={inputCls} /></Field>
          <div className="sm:col-span-3">
            <button type="submit" disabled={ai.busy} className="h-9 rounded-md bg-evergreen px-4 text-sm font-medium text-white hover:bg-evergreen/90 disabled:opacity-60">
              {ai.busy ? "Estimating… (takes 15–30s)" : "Run AI estimate"}
            </button>
            <span className="ml-2 text-xs text-faint" aria-live="polite">
              {ai.busy
                ? "The AI is reasoning over these facts and the listing figures — hang tight."
                : ai.done
                  ? "Estimate saved ✓ — the AI figure and its reasoning now show above."
                  : aiAnchors.length
                    ? `Prefilled from the listing; the AI adjusts from ${aiAnchors.join(" + ")} and saves its reasoning.`
                    : "The AI reasons from these facts (plus any Zillow/Redfin figures) and saves the value with its reasoning."}
            </span>
          </div>
        </form>
      )}

      {/* edit details: name / address / links / headline source / delete */}
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Edit details &amp; pick the headline figure</summary>
        <form onSubmit={edit.onSubmit} className="mt-3 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="entityId" value={entityId} />
          <input type="hidden" name="componentId" value={c.id} />
          <Field label="Name"><input name="label" defaultValue={c.label} className={inputCls} /></Field>
          <Field label="Address"><input name="address" defaultValue={c.address ?? ""} className={inputCls} /></Field>
          <Field label="Zillow link"><input name="zillowUrl" defaultValue={c.zillowUrl ?? ""} className={inputCls} /></Field>
          <Field label="Redfin link"><input name="redfinUrl" defaultValue={c.redfinUrl ?? ""} className={inputCls} /></Field>
          <Field label="Headline figure">
            <select name="chosenSource" defaultValue={c.chosenSource ?? ""} className={inputCls}>
              <option value="">Best available — the highest figure</option>
              {sources.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
            </select>
          </Field>
          <div className="flex items-end gap-2">
            <button type="submit" disabled={edit.busy} className="h-9 rounded-md bg-evergreen px-4 text-sm font-medium text-white hover:bg-evergreen/90 disabled:opacity-60">
              {edit.busy ? "Saving…" : "Save"}
            </button>
            {edit.done && <span className="pb-2 text-xs text-evergreen" aria-live="polite">Saved ✓</span>}
          </div>
        </form>
        <form action={removeComponent} className="mt-2">
          <input type="hidden" name="entityId" value={entityId} />
          <input type="hidden" name="componentId" value={c.id} />
          <button type="submit" className="text-xs text-oxblood hover:underline">Remove this piece</button>
        </form>
      </details>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

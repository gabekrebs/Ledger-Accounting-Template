"use client";

import { useState } from "react";
import Link from "next/link";
import { createEntity } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const TAX_TYPES = [
  { value: "partnership", label: "Partnership (multi-member LLC / LP)" },
  { value: "single_member_llc", label: "Single-member LLC (Schedule C / E)" },
  { value: "schedule_e", label: "Schedule E (individual rental)" },
  { value: "s_corp", label: "S-Corporation" },
  { value: "c_corp", label: "C-Corporation" },
] as const;

const VALUATION_METHODS = [
  { value: "income", label: "Income property — cap-rate on NOI" },
  { value: "market", label: "Market value — Zillow / Redfin comps" },
  { value: "none", label: "No real estate — operating or holding co" },
] as const;

const SELECT_CLS = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

export function NewEntityForm() {
  const [partners, setPartners] = useState([{ name: "", pct: "" }]);

  function addPartner() {
    setPartners((p) => [...p, { name: "", pct: "" }]);
  }
  function removePartner(i: number) {
    setPartners((p) => p.filter((_, idx) => idx !== i));
  }
  function updatePartner(i: number, field: "name" | "pct", value: string) {
    setPartners((p) => p.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));
  }

  const totalPct = partners.reduce((s, p) => s + (parseFloat(p.pct) || 0), 0);
  const pctOk = partners.every((p) => !p.name || (parseFloat(p.pct) > 0));

  return (
    <main className="flex-1 px-6 py-12">
      <div className="mx-auto w-full max-w-xl space-y-8">
        <div>
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← All entities
          </Link>
          <h1 className="mt-2 font-serif text-3xl font-medium tracking-tight">
            Add entity
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Creates the entity in the ledger. You can import Wave history afterward.
          </p>
        </div>

        <form action={createEntity} className="space-y-6">
          {/* Basic info */}
          <fieldset className="space-y-4">
            <legend className="text-sm font-medium text-foreground">Entity details</legend>

            <div className="space-y-1.5">
              <Label htmlFor="name">Display name</Label>
              <Input id="name" name="name" required placeholder="" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="legalName">
                Legal name{" "}
                <span className="text-muted-foreground font-normal">(optional — defaults to display name)</span>
              </Label>
              <Input id="legalName" name="legalName" placeholder="" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="taxType">Entity / tax type</Label>
              <select id="taxType" name="taxType" defaultValue="partnership" className={SELECT_CLS}>
                {TAX_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="valuationMethod">Valuation method</Label>
              <select id="valuationMethod" name="valuationMethod" defaultValue="income" className={SELECT_CLS}>
                {VALUATION_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </fieldset>

          {/* Ownership */}
          <fieldset className="space-y-3">
            <div className="flex items-center justify-between">
              <legend className="text-sm font-medium text-foreground">
                Owners / partners{" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </legend>
              {totalPct > 0 && (
                <span className={`text-xs tabular-nums ${Math.abs(totalPct - 100) < 0.01 ? "text-green-600" : "text-amber-600"}`}>
                  {totalPct.toFixed(1)}%
                </span>
              )}
            </div>

            <div className="space-y-2">
              {partners.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    name={`partner_name_${i}`}
                    value={p.name}
                    onChange={(e) => updatePartner(i, "name", e.target.value)}
                    placeholder="Partner name"
                    className="flex-1"
                  />
                  <div className="relative w-28 shrink-0">
                    <Input
                      name={`partner_pct_${i}`}
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={p.pct}
                      onChange={(e) => updatePartner(i, "pct", e.target.value)}
                      placeholder="50"
                      className="pr-6"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      %
                    </span>
                  </div>
                  {partners.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removePartner(i)}
                      className="shrink-0 text-muted-foreground hover:text-destructive text-sm px-1"
                      aria-label="Remove partner"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addPartner}
              className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
            >
              + Add partner
            </button>
          </fieldset>

          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" disabled={!pctOk}>
              Create entity
            </Button>
            <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}

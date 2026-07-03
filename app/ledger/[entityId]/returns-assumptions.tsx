"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type ReturnsAssumptions = {
  /** Federal marginal tax rate %. */
  fedRate: number;
  setFedRate: (n: number) => void;
  /** State marginal tax rate % (default Oregon's 9.9% top bracket). */
  stateRate: number;
  setStateRate: (n: number) => void;
  /**
   * Combined marginal rate = federal + state (additive). Under the $10k SALT cap
   * incremental state income tax isn't federally deductible for an owner already
   * over the cap on property tax, so additive is the right combined rate. (An
   * Oregon PTE-E election would make state tax federally deductible — lowering
   * the effective rate to fed + state×(1−fed); a second-order refinement we
   * footnote rather than model.) Drives the depreciation tax shield.
   */
  taxRate: number;
  /** Whether depreciation losses shelter income now (else deferred to sale → $0). */
  lossesUsable: boolean;
  setLossesUsable: (b: boolean) => void;
};

const ReturnsAssumptionsContext = createContext<ReturnsAssumptions | null>(null);

/**
 * Shares the marginal-tax-rate and losses-usable assumptions across the Overview
 * so the hero card's sliders and the Performance-by-year returns move together —
 * both lean on the same net invested basis (contributed capital less the
 * depreciation tax deferred), so they must read one source of truth. Federal and
 * state are separate sliders so each assumption is explicit; `taxRate` is their
 * sum, the single combined rate the tax math consumes. Oregon conforms to the
 * federal passive-activity-loss rules, so one `lossesUsable` flag covers both.
 */
export function ReturnsAssumptionsProvider({ children }: { children: ReactNode }) {
  const [fedRate, setFedRate] = useState(37);
  const [stateRate, setStateRate] = useState(9.9);
  const [lossesUsable, setLossesUsable] = useState(true);
  return (
    <ReturnsAssumptionsContext.Provider
      value={{
        fedRate,
        setFedRate,
        stateRate,
        setStateRate,
        taxRate: fedRate + stateRate,
        lossesUsable,
        setLossesUsable,
      }}
    >
      {children}
    </ReturnsAssumptionsContext.Provider>
  );
}

export function useReturnsAssumptions() {
  const ctx = useContext(ReturnsAssumptionsContext);
  if (!ctx)
    throw new Error(
      "useReturnsAssumptions must be used within a ReturnsAssumptionsProvider"
    );
  return ctx;
}

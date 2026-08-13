import Link from "next/link";

/**
 * The P&L's view switch — Full company ↔ By address (owner decision
 * 2026-07-30: per-address is a VIEW of the P&L, not a nav tab; its tab slot
 * went to Utilities). Sits above every other control on both pages; the
 * default landing is always Full company. Server component — two links, no
 * state; each page passes which side is lit.
 */
export function PlViewToggle({
  entityId,
  view,
}: {
  entityId: string;
  view: "company" | "address";
}) {
  const base = `/ledger/${entityId}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
        View
      </span>
      <ToggleChip href={`${base}/pl`} active={view === "company"}>
        Full company
      </ToggleChip>
      <ToggleChip href={`${base}/by-address`} active={view === "address"}>
        By address
      </ToggleChip>
    </div>
  );
}

function ToggleChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-sm transition-colors ${
        active
          ? "bg-evergreen text-white"
          : "bg-secondary text-muted-foreground hover:bg-evergreen-soft hover:text-evergreen"
      }`}
    >
      {children}
    </Link>
  );
}

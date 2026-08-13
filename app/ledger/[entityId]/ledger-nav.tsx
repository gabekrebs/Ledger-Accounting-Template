"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderOpen, Users } from "lucide-react";

// Tabs are ordered into two legible clusters of financial CONTENT — Overview
// (home) · Reports (the formal statements) · Ledger (the underlying records).
// Entity UTILITIES (Documents, Access) deliberately live in the page header
// (`EntityUtilityNav`), not here: they aren't statements or records, and
// keeping them out is what lets the row fit the max-w-page container on one
// line without cramming — `--container-page` in globals.css is sized to this
// row's widest case (an entity with the Utilities tab). `groupStart` draws a
// hairline divider before the tab so the eye parses groups, not ten equal peers.
// The per-address P&L is a VIEW of the P&L (toggle at the top of that page,
// owner decision 2026-07-30), not a tab — its slot went to Utilities, which
// appears only for entities with a configured utility tracker.
const TABS: {
  slug: string;
  label: string;
  utilitiesOnly?: boolean;
  groupStart?: boolean;
}[] = [
  { slug: "", label: "Overview" },

  // Reports — the formal statements, ordered to read as a story:
  // income → position → the debt behind it → what the asset is worth.
  { slug: "pl", label: "P&L", groupStart: true },
  { slug: "bs", label: "Balance Sheet" },
  { slug: "loans", label: "Loans" },
  { slug: "valuation", label: "Valuation" },
  // Last in the Reports cluster (owner request): a niche report shouldn't
  // sit between the P&L and the balance sheet.
  { slug: "utilities", label: "Utilities", utilitiesOnly: true },

  // Ledger — the underlying records and operations.
  { slug: "transactions", label: "Transactions", groupStart: true },
  // The formal record — full GL report; per-account drill-downs live under it.
  { slug: "gl", label: "General Ledger" },
  { slug: "accounts", label: "Accounts" },
  // "Review" (the bank-feed inbox) names the job and disambiguates from
  // "Accounts"; the route slug stays `bank`.
  { slug: "bank", label: "Review" },
  // Balance health per account — book vs bank, at a glance. The per-account
  // statement-tie workspace lives under it (`reconcile/[accountId]`).
  { slug: "reconcile", label: "Reconciliation" },
  // Categorization rules — entity overrides + inherited global rules.
  { slug: "rules", label: "Rules" },
];

export function LedgerNav({
  base,
  showUtilities = false,
}: {
  base: string;
  showUtilities?: boolean;
}) {
  const pathname = usePathname();
  const tabs = TABS.filter((t) => !t.utilitiesOnly || showUtilities);
  return (
    // flex-wrap stays as the narrow-window fallback; at full width every tab
    // fits on one line (max-w-page container + the tighter px-2.5 tabs).
    <nav className="flex flex-wrap gap-x-0.5 gap-y-0.5 border-b border-hair -mb-px">
      {tabs.map((t, i) => {
        const href = t.slug ? `${base}/${t.slug}` : base;
        // The per-address view lives at /by-address but is reached through
        // the P&L's view toggle — the P&L tab stays lit there.
        const active =
          t.slug === ""
            ? pathname === base
            : t.slug === "pl"
              ? pathname.startsWith(`${base}/pl`) ||
                pathname.startsWith(`${base}/by-address`)
              : pathname.startsWith(`${base}/${t.slug}`);
        return (
          <Fragment key={t.slug}>
            {t.groupStart && i > 0 && (
              <span
                aria-hidden
                className="mx-1.5 my-2 w-px self-stretch bg-hair"
              />
            )}
            <Link
              href={href}
              className={`px-2.5 py-2 text-sm border-b-2 transition-colors ${
                active
                  ? "border-evergreen text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </Link>
          </Fragment>
        );
      })}
    </nav>
  );
}

// Entity utilities — the document vault and (admin-only) access management.
// Rendered in the page header next to the entity name, NOT in the tab row:
// they're meta, not financial content, and the tab row stays uncrammed.
const UTILITIES: { slug: string; label: string; Icon: typeof FolderOpen; adminOnly?: boolean }[] = [
  { slug: "documents", label: "Documents", Icon: FolderOpen },
  // Who can see this entity — mirrors /ledger/users, scoped here.
  { slug: "access", label: "Access", Icon: Users, adminOnly: true },
];

export function EntityUtilityNav({
  base,
  showAccess = false,
}: {
  base: string;
  showAccess?: boolean;
}) {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1.5">
      {UTILITIES.filter((u) => !u.adminOnly || showAccess).map((u) => {
        const href = `${base}/${u.slug}`;
        const active = pathname.startsWith(href);
        return (
          <Link
            key={u.slug}
            href={href}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              active
                ? "border-evergreen/40 text-evergreen"
                : "border-hair text-muted-foreground hover:border-evergreen/40 hover:text-evergreen"
            }`}
          >
            <u.Icon className="h-3.5 w-3.5" aria-hidden />
            {u.label}
          </Link>
        );
      })}
    </div>
  );
}

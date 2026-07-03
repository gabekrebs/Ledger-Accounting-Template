"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderOpen, Users, Upload } from "lucide-react";

// Tabs are ordered into two legible clusters of financial CONTENT — Overview
// (home) · Reports (the formal statements) · Ledger (the underlying records).
// Entity UTILITIES (Documents, Access) deliberately live in the page header
// (`EntityUtilityNav`), not here: they aren't statements or records, and
// keeping them out is what lets the row fit the max-w-5xl container without
// cramming. `groupStart` draws a hairline divider before the tab so the eye
// parses groups, not ten equal peers.
const TABS: {
  slug: string;
  label: string;
  locationOnly?: boolean;
  groupStart?: boolean;
}[] = [
  { slug: "", label: "Overview" },

  // Reports — the formal statements, ordered to read as a story:
  // income → position → the debt behind it → what the asset is worth.
  { slug: "pl", label: "P&L", groupStart: true },
  { slug: "by-address", label: "By Address", locationOnly: true },
  { slug: "bs", label: "Balance Sheet" },
  { slug: "loans", label: "Loans" },
  { slug: "valuation", label: "Valuation" },

  // Ledger — the underlying records and operations.
  { slug: "transactions", label: "Transactions", groupStart: true },
  // The formal record — full GL report; per-account drill-downs live under it.
  { slug: "gl", label: "General Ledger" },
  { slug: "accounts", label: "Accounts" },
  // "Review" (the bank-feed inbox) names the job and disambiguates from
  // "Accounts"; the route slug stays `bank`.
  { slug: "bank", label: "Review" },
  // Categorization rules — entity overrides + inherited global rules.
  { slug: "rules", label: "Rules" },
];

export function LedgerNav({
  base,
  showByAddress = false,
}: {
  base: string;
  showByAddress?: boolean;
}) {
  const pathname = usePathname();
  const tabs = TABS.filter((t) => !t.locationOnly || showByAddress);
  return (
    <nav className="flex gap-1 overflow-x-auto whitespace-nowrap border-b border-hair -mb-px">
      {tabs.map((t, i) => {
        const href = t.slug ? `${base}/${t.slug}` : base;
        const active =
          t.slug === ""
            ? pathname === base
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
              className={`px-3 py-2 text-sm border-b-2 transition-colors ${
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
  { slug: "import", label: "Import", Icon: Upload },
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

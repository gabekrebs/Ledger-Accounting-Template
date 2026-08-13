"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export interface EntityListItem {
  id: string;
  name: string | null;
  legalName: string | null;
  taxType: string | null;
  importedThrough: string | null;
  propertyAddress: string | null;
}

/**
 * Searchable entity grid for the ledger home page. Every typed word must match
 * somewhere in the entity's name / legal name / property address, so "ne 26th"
 * or "hospitality" both narrow naturally.
 */
export function EntitySearchList({ entities }: { entities: EntityListItem[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return entities;
    return entities.filter((e) => {
      const hay = [e.name, e.legalName, e.propertyAddress]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [entities, query]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search entities…"
          aria-label="Search entities"
          autoFocus
          className="max-w-sm"
        />
        <span className="text-sm text-muted-foreground">
          {filtered.length === entities.length
            ? `${entities.length} entities`
            : `${filtered.length} of ${entities.length}`}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No entities match “{query}”.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filtered.map((e) => (
            <Link key={e.id} href={`/ledger/${e.id}`}>
              <Card className="transition-colors hover:border-zinc-400 dark:hover:border-zinc-500">
                <CardHeader>
                  <CardTitle className="text-lg">{e.name}</CardTitle>
                  <CardDescription className="flex items-center gap-2">
                    {e.taxType && <Badge variant="secondary">{e.taxType}</Badge>}
                    {e.importedThrough && (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        through {e.importedThrough}
                      </span>
                    )}
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

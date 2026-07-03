"use client";

import { useRouter } from "next/navigation";

export function ActivityFilter({
  base,
  activities,
  current,
  searchParams,
}: {
  base: string;
  activities: string[];
  current: string | undefined;
  searchParams: Record<string, string | undefined>;
}) {
  const router = useRouter();

  function setActivity(value: string) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (k !== "activity" && v) q.set(k, v);
    }
    if (value) q.set("activity", value);
    const qs = q.toString();
    router.push(qs ? `${base}?${qs}` : base);
  }

  const options = [
    { value: "", label: "Full P&L" },
    ...activities.map((a) => ({ value: a, label: `${a} only` })),
  ];

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Activity:</span>
      <div className="flex items-center gap-1">
        {options.map((o) => {
          const active = (current ?? "") === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => setActivity(o.value)}
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                active
                  ? "border-evergreen bg-evergreen-soft text-evergreen"
                  : "border-hair text-muted-foreground hover:border-evergreen/40 hover:text-evergreen"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

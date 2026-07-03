"use client";

import { useSyncExternalStore } from "react";

type Daypart = "morning" | "afternoon" | "evening";

function currentDaypart(): Daypart {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}

const GREETINGS: Record<Daypart, { heading: (n: string) => string; subtitle: string }> = {
  morning: { heading: (n) => `Morning ${n}`, subtitle: "What's on the agenda today?" },
  afternoon: { heading: (n) => `Hello ${n}`, subtitle: "Let's keep the books beautiful." },
  evening: { heading: (n) => `Good evening ${n}`, subtitle: "Welcome back." },
};

// The clock is an external system: reading it during SSR and hydration would
// mismatch, so subscribe via useSyncExternalStore — the server snapshot renders
// the neutral afternoon copy, the client snapshot swaps in the real daypart on
// hydration. (No subscription needed: the value only matters at page load.)
const subscribeNever = () => () => {};

export function Greeting({ name }: { name: string }) {
  const daypart = useSyncExternalStore(
    subscribeNever,
    currentDaypart,
    () => "afternoon" as Daypart
  );
  const g = GREETINGS[daypart];

  return (
    <div className="text-center">
      <h1 className="font-serif text-4xl font-medium tracking-tight sm:text-5xl sm:whitespace-nowrap">
        {g.heading(name)}
      </h1>
      <p className="mt-3 text-muted-foreground">
        {g.subtitle}
      </p>
    </div>
  );
}

"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { MoonIcon, SunIcon } from "lucide-react";

// Same hydration trick as Greeting: the theme only exists client-side, so the
// server snapshot renders a blank placeholder and the client snapshot swaps in
// the real icon on hydration — no mismatch, no setState-in-effect.
const subscribeNever = () => () => {};

/**
 * Sun/moon switch in the header. Until first use the site follows the OS
 * appearance; a click sets an explicit choice that next-themes persists in
 * localStorage (per browser).
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  );
  const dark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="text-muted-foreground transition-colors hover:text-foreground"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {!mounted ? (
        <span className="block h-3.5 w-3.5" />
      ) : dark ? (
        <SunIcon className="h-3.5 w-3.5" />
      ) : (
        <MoonIcon className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

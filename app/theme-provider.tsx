"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** Client boundary for next-themes — the root layout stays a server component. */
export function ThemeProvider(
  props: React.ComponentProps<typeof NextThemesProvider>
) {
  return <NextThemesProvider {...props} />;
}

"use client";

import { createContext, useContext } from "react";

/**
 * Per-entity capability context, provided once by the entity layout (which is
 * the server-side source of truth via `currentUserEntityAccessLevel`). Client
 * write-controls that appear on many surfaces (the edit pencil, the new-entry
 * button, …) consume this to self-hide for read-only users instead of every
 * page threading a prop through its tables. UI-gating only — every server
 * action re-asserts write access regardless.
 *
 * Default is read-only, so a write control rendered OUTSIDE the entity layout
 * fails safe (hidden) rather than appearing to users who can't use it.
 */
const EntityCapabilitiesContext = createContext<{ readOnly: boolean }>({
  readOnly: true,
});

export function EntityCapabilities({
  readOnly,
  children,
}: {
  readOnly: boolean;
  children: React.ReactNode;
}) {
  return (
    <EntityCapabilitiesContext.Provider value={{ readOnly }}>
      {children}
    </EntityCapabilitiesContext.Provider>
  );
}

/** True when the current user may not write to the entity being viewed. */
export function useEntityReadOnly(): boolean {
  return useContext(EntityCapabilitiesContext).readOnly;
}

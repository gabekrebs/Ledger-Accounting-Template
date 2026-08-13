"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fuzzyMatch } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

export type PickerProperty = { id: string; name: string };

// Keystrokes originating in another editable control never open the picker.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

const SearchGlyph = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
  </svg>
);

/**
 * The home page's launchpad into a property: a quiet card that expands into a
 * Raycast-style command palette. Keyboard-first — on desktop, typing anywhere
 * on the page (plus "/" and ⌘K/Ctrl+K) opens it with the keystroke already in
 * the search box; the full list is one click away on mobile. Fuzzy matching
 * lives in lib/fuzzy.ts; results stay alphabetical (the server sends them
 * sorted) with the best-scoring match pre-highlighted.
 */
export function PropertyPicker({
  properties,
  commandKHref,
  commandRHref,
  commandIHref,
}: {
  properties: PickerProperty[];
  // ⌘K/Ctrl+K jumps straight here (the pinned holding co — the owner's most
  // frequent destination) instead of opening the picker; typing and "/" stay
  // the search shortcuts. Omitted (no pinned entity in the user's accessible
  // set) → ⌘K falls back to toggling the picker.
  commandKHref?: string;
  // ⌘R/Ctrl+R jumps here (the Review Queue), overriding the browser's reload
  // on THIS page only. Omitted → reload behaves normally. ⌘P is swallowed
  // (does nothing) either way — see onKey.
  commandRHref?: string;
  // ⌘I/Ctrl+I jumps here (optional shortcut target) — passed only when the
  // home page mounts this component, so the shortcut never exists elsewhere.
  // Like ⌘K/⌘R it fires even when focus is in a form field (owner request).
  commandIHref?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Arrow-key/hover position. null = follow the best fuzzy match as the user
  // types; any explicit navigation pins the highlight until the query changes.
  const [nav, setNav] = useState<number | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return properties.map((p) => ({ ...p, score: 0, indices: [] as number[] }));
    return properties.flatMap((p) => {
      const m = fuzzyMatch(q, p.name);
      return m ? [{ ...p, ...m }] : [];
    });
  }, [properties, query]);

  // Alphabetical order is preserved above; the highlight jumps to the best
  // score so "oak" lands on Oak Park even when something earlier also matches.
  const bestIdx = useMemo(() => {
    let idx = 0;
    for (let i = 1; i < results.length; i++) if (results[i].score > results[idx].score) idx = i;
    return idx;
  }, [results]);
  const activeIdx =
    results.length === 0 ? -1 : nav === null ? bestIdx : Math.min(nav, results.length - 1);

  function openPicker(seed = "") {
    setQuery(seed);
    setNav(null);
    setOpen(true);
  }

  // restoreFocus only for keyboard dismissal — after an outside click, focus
  // should stay wherever the user clicked.
  function closePicker(restoreFocus: boolean) {
    setOpen(false);
    setQuery("");
    setNav(null);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function pick(id: string) {
    setOpen(false);
    router.push(`/ledger/${id}`);
  }

  // Page-level shortcuts. Guards keep every other shortcut intact: modifier
  // chords (except ⌘/Ctrl+K), keystrokes inside editable controls, and
  // non-printable keys all pass through untouched.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (commandKHref) {
          setOpen(false);
          router.push(commandKHref);
        } else if (open) {
          closePicker(true);
        } else {
          openPicker();
        }
        return;
      }
      if (
        commandRHref &&
        (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
        e.key.toLowerCase() === "r"
      ) {
        e.preventDefault();
        setOpen(false);
        router.push(commandRHref);
        return;
      }
      if (
        commandIHref &&
        (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
        e.key.toLowerCase() === "i"
      ) {
        e.preventDefault();
        setOpen(false);
        router.push(commandIHref);
        return;
      }
      // ⌘P is deliberately inert on the home page (owner request): it used to
      // open the old pending inbox, and the muscle memory would otherwise
      // trigger the print dialog.
      if (
        (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
        e.key.toLowerCase() === "p"
      ) {
        e.preventDefault();
        return;
      }
      if (open || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      if (e.key === "/") {
        e.preventDefault();
        openPicker();
      } else if (e.key.length === 1 && /[\p{L}\p{N}]/u.test(e.key)) {
        e.preventDefault();
        openPicker(e.key);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, commandKHref, commandRHref, commandIHref, router]);

  // Focus the search box on open, caret after any seeded character.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  // Any press outside dismisses.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closePicker(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
     
  }, [open]);

  // Keep the highlighted row visible while arrowing / filtering.
  useEffect(() => {
    if (!open || activeIdx < 0) return;
    listRef.current
      ?.querySelector(`[data-idx="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx, results]);

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length > 0) setNav(Math.min(activeIdx + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length > 0) setNav(Math.max(activeIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[activeIdx];
      if (hit) pick(hit.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePicker(true);
    } else if (e.key === "Tab") {
      closePicker(false);
    }
  }

  const activeId = activeIdx >= 0 ? `property-option-${results[activeIdx].id}` : undefined;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closePicker(false) : openPicker())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Open property — type to search"
        className={cn(
          // bg-card (white on the paper page) + a resting shadow reads as the
          // primary, ready-for-input control next to the flat tinted pinned card.
          "group flex w-full items-center gap-2.5 rounded-lg border border-hair bg-card px-3.5 py-3 text-left",
          "shadow-[0_1px_2px_rgb(28_27_25/0.04)]",
          "transition-all duration-150 hover:border-evergreen/40 hover:shadow-[0_3px_12px_-2px_rgb(28_27_25/0.10)]",
          "focus-visible:outline-2 focus-visible:outline-offset-2"
        )}
      >
        <SearchGlyph className="h-4 w-4 shrink-0 text-faint transition-colors group-hover:text-evergreen" />
        <span className="whitespace-nowrap text-sm font-medium transition-colors group-hover:text-evergreen">
          Open property
        </span>
        {/* Idle hint — an input at rest, not an advertisement. The blinking
            caret is the whole "alive" signal; keyboard-only, so hidden where
            there is no keyboard. Sized to share the row with the label at the
            card's w-60 (review-card-matched) width. */}
        <span className="ml-auto hidden items-center gap-1.5 pointer-fine:flex" aria-hidden>
          <span className="h-3.5 w-px animate-caret-blink bg-faint/60 motion-reduce:animate-none" />
          <span className="whitespace-nowrap text-[11px] text-faint/70">Type to search</span>
        </span>
      </button>

      {open && (
        // Anchored over the card at the card's exact width (property names are
        // short) so the palette reads as the card morphing in place.
        <div className="absolute inset-x-0 top-0 z-50">
          <div
            className={cn(
              "overflow-hidden rounded-xl border border-hair bg-popover",
              // Three-layer shadow — contact line, ambient, and a long soft
              // throw — so the palette floats without a heavy outline.
              "shadow-[0_1px_2px_rgb(28_27_25/0.05),0_12px_32px_-8px_rgb(28_27_25/0.14),0_32px_72px_-16px_rgb(28_27_25/0.20)]",
              // Expo-out: fast arrival, long settle — the Raycast/Linear feel.
              "animate-in fade-in-0 zoom-in-98 slide-in-from-top-1 duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none"
            )}
          >
            <div className="flex items-center gap-3 border-b border-hair px-4">
              <SearchGlyph className="h-4 w-4 shrink-0 text-faint/80" />
              <input
                ref={inputRef}
                role="combobox"
                aria-expanded="true"
                aria-controls="property-listbox"
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                aria-label="Search properties"
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setNav(null);
                }}
                onKeyDown={onInputKeyDown}
                placeholder="Search properties…"
                className="h-[3.25rem] min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint/60"
              />
            </div>
            <div
              ref={listRef}
              role="listbox"
              id="property-listbox"
              aria-label="Properties"
              className="max-h-[19rem] overflow-y-auto p-2 [scrollbar-color:var(--hair)_transparent] [scrollbar-width:thin]"
            >
              {results.length === 0 ? (
                <div className="px-4 py-14 text-center">
                  <p className="text-sm text-muted-foreground">No properties match</p>
                  <p className="mt-1.5 truncate text-sm text-faint/80">&ldquo;{query.trim()}&rdquo;</p>
                </div>
              ) : (
                results.map((p, idx) => (
                  <button
                    key={p.id}
                    id={`property-option-${p.id}`}
                    type="button"
                    role="option"
                    aria-selected={idx === activeIdx}
                    tabIndex={-1}
                    data-idx={idx}
                    // mousemove, not mouseenter: keyboard scrolling moves rows
                    // under a resting cursor, and enter would steal the highlight.
                    onMouseMove={() => setNav(idx)}
                    onClick={() => pick(p.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm",
                      "transition-colors duration-100",
                      idx === activeIdx && "bg-evergreen/8"
                    )}
                  >
                    <HighlightedName name={p.name} indices={p.indices} />
                    <span
                      className={cn(
                        "shrink-0 text-xs text-evergreen/50 transition-opacity duration-100",
                        idx === activeIdx ? "opacity-100" : "opacity-0"
                      )}
                      aria-hidden
                    >
                      ↵
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Matched characters in medium-weight evergreen — enough to explain why "nwj"
// hit NW Johnson without turning the list into a highlighter reel.
function HighlightedName({ name, indices }: { name: string; indices: number[] }) {
  if (indices.length === 0) return <span className="truncate">{name}</span>;
  const hits = new Set(indices);
  const segments: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < name.length; i++) {
    const hit = hits.has(i);
    const last = segments[segments.length - 1];
    if (last && last.hit === hit) last.text += name[i];
    else segments.push({ text: name[i], hit });
  }
  return (
    <span className="truncate">
      {segments.map((s, i) =>
        s.hit ? (
          <span key={i} className="font-medium text-evergreen">
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </span>
  );
}

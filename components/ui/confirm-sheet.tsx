"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The module's one confirmation surface, replacing native confirm() for
 * consequential actions. Built on Base UI's Dialog (focus trap + restore,
 * Escape, aria wiring, scroll lock come from the primitive); presentation is
 * a bottom sheet under `sm` (thumb reach on a phone) and a centered card
 * on desktop. `children` carries structured content — summaries, plan rows —
 * instead of a flattened string.
 */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  onConfirm,
  pending = false,
  confirmDisabled = false,
  destructive = false,
  cancelLabel = "Cancel",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One-sentence consequence statement, read to screen readers. */
  description?: string;
  children?: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  confirmDisabled?: boolean;
  destructive?: boolean;
  cancelLabel?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !pending && onOpenChange(o)} modal>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-ink/40 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            // Phone: bottom sheet, full width, safe-area padded.
            "fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-hair bg-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_-8px_32px_-8px_rgb(28_27_25/0.25)] outline-none",
            "transition-transform data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full",
            // Desktop: centered card.
            "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:p-6 sm:shadow-[0_16px_48px_-12px_rgb(28_27_25/0.3)]",
            "sm:transition-opacity sm:data-[ending-style]:translate-y-[-50%] sm:data-[starting-style]:translate-y-[-50%] sm:data-[ending-style]:opacity-0 sm:data-[starting-style]:opacity-0"
          )}
        >
          <Dialog.Title className="font-serif text-lg">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">
              {description}
            </Dialog.Description>
          )}
          {children && <div className="mt-3 text-sm">{children}</div>}
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close
              render={
                <Button variant="ghost" className="h-11 sm:h-9" disabled={pending}>
                  {cancelLabel}
                </Button>
              }
            />
            <Button
              variant={destructive ? "destructive" : "default"}
              className="h-11 sm:h-9"
              disabled={pending || confirmDisabled}
              onClick={onConfirm}
            >
              {pending ? "Working…" : confirmLabel}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { cn } from "@/lib/utils";

/**
 * A statement section: a serif title (optional description + right-aligned
 * action) over its content, separated from neighbors by whitespace and a
 * hairline — boxes removed. The Overview is built from these.
 */
export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="font-serif text-lg font-medium tracking-tight">{title}</h2>
          {description && (
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0 text-sm">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** A hairline divider between sections. */
export function Rule() {
  return <hr className="border-0 border-t border-hair" />;
}

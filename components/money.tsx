import { cn } from "@/lib/utils";

/**
 * A money figure in the ledger's house style: mono tabular numerals, dollars at
 * full weight, cents demoted (smaller + lighter), negatives in accounting
 * parentheses. `tone` colors the whole figure (evergreen for positive emphasis,
 * oxblood for negative). The eye reads dollars first; columns align like a ledger.
 */
export function Money({
  cents,
  paren = true,
  sign = false,
  tone = "plain",
  className,
}: {
  cents: number;
  /** Show negatives as (1,234.56) rather than -$1,234.56. */
  paren?: boolean;
  /** Prefix non-negative values with a +. */
  sign?: boolean;
  /** plain = inherit · auto = oxblood when negative · pos/neg = force color. */
  tone?: "plain" | "auto" | "pos" | "neg";
  className?: string;
}) {
  const neg = cents < 0;
  const str = (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const [dollars, c] = str.split(".");
  const toneCls =
    tone === "pos"
      ? "text-evergreen"
      : tone === "neg"
        ? "text-oxblood"
        : tone === "auto" && neg
          ? "text-oxblood"
          : undefined;

  return (
    <span className={cn("font-mono tabular-nums whitespace-nowrap", toneCls, className)}>
      {neg ? (paren ? "(" : "−") : sign ? "+" : ""}${dollars}
      <span className="text-[0.78em] opacity-60">.{c}</span>
      {neg && paren ? ")" : ""}
    </span>
  );
}

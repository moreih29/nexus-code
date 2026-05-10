/**
 * GitStatusBadge renders the one-letter Source Control status signifier.
 *
 * Per design.md "almost monochromatic" mission, color is intentionally NOT the
 * primary signifier — the letter glyph (M / A / D / R / C / ? / T / !) is.
 * Active changes (M / T / A / ?) get full-emphasis foreground with semibold
 * weight; passive structural changes (R / C) use muted-foreground; only
 * destructive (D) and conflict (!) draw on the destructive token, with
 * conflict adding a subtle bg tint to differentiate at a glance.
 */
import { cn } from "@/utils/cn";

interface GitStatusBadgeProps {
  code: string;
}

function statusBadgeClass(code: string): string {
  switch (code) {
    case "M":
    case "T":
    case "A":
    case "?":
      return "text-foreground font-semibold";
    case "D":
      return "text-destructive";
    case "R":
    case "C":
      return "text-muted-foreground";
    case "!":
      return "text-destructive bg-destructive/10 font-semibold";
    default:
      return "text-muted-foreground";
  }
}

export function GitStatusBadge({ code }: GitStatusBadgeProps) {
  const label = code === "!" ? "conflict" : code;
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] font-mono text-app-ui-sm leading-none",
        statusBadgeClass(code),
      )}
      role="img"
      aria-label={`Git status ${label}`}
      title={`Git status ${label}`}
    >
      {code.slice(0, 1)}
    </span>
  );
}

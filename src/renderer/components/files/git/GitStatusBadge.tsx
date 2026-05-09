/**
 * GitStatusBadge renders the one-letter Source Control status signifier.
 */
import { cn } from "@/utils/cn";

interface GitStatusBadgeProps {
  code: string;
}

const FALLBACK_STATUS_COLORS: Record<string, React.CSSProperties | undefined> = {
  M: { color: "var(--color-warning, #d6a94d)" },
  T: { color: "var(--color-warning, #d6a94d)" },
  A: { color: "var(--color-success, #75b978)" },
  "?": { color: "var(--color-success, #75b978)" },
};

function statusBadgeClass(code: string): string {
  switch (code) {
    case "M":
    case "T":
      return "text-warning";
    case "A":
    case "?":
      return "text-success";
    case "D":
      return "text-destructive";
    case "R":
    case "C":
      return "text-muted-foreground";
    case "!":
      return "text-destructive bg-destructive/10";
    default:
      return "text-muted-foreground";
  }
}

export function GitStatusBadge({ code }: GitStatusBadgeProps) {
  const label = code === "!" ? "conflict" : code;
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] font-mono text-app-ui-sm font-medium leading-none",
        statusBadgeClass(code),
      )}
      style={FALLBACK_STATUS_COLORS[code]}
      role="img"
      aria-label={`Git status ${label}`}
      title={`Git status ${label}`}
    >
      {code.slice(0, 1)}
    </span>
  );
}

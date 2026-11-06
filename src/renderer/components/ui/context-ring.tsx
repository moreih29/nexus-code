// How full a conversation's context is, as a ring that fills clockwise:
// the loading colour, turning to the warning colour from 80%.

import { cn } from "@/utils/cn";

export function ContextRing({ percent, className }: { percent: number; className?: string }) {
  const r = 5;
  const length = 2 * Math.PI * r;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={cn("size-3 shrink-0 -rotate-90", className)}
    >
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth={2}
      />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeDasharray={`${(length * percent) / 100} ${length}`}
        className={percent >= 80 ? "text-(--state-warning-fg)" : "text-(--state-loading-indicator)"}
      />
    </svg>
  );
}

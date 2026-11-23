import { cn } from "@/utils/cn";

export function RowDropIndicator() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "absolute left-2 right-2 top-1/2 -translate-y-1/2 h-0.5 rounded-full",
        "bg-[var(--state-selected-indicator)]",
        "pointer-events-none",
        "transition-opacity duration-100 ease-out",
      )}
    />
  );
}

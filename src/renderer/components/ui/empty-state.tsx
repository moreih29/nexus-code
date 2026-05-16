/**
 * EmptyState — generic centered placeholder for empty or onboarding panel states.
 *
 * Replaces the git-specific GitEmptyState so other surfaces (search, history,
 * file tree) can use the same centering + icon + copy + optional CTA pattern
 * without coupling to git terminology.
 *
 * `tone` controls title typography (design.md §5):
 *   - "label"  (default) — uppercase small-label, for category/empty state headings
 *                          ("NO CHANGES", "NO RESULTS" …)
 *   - "status" — sentence-case app-ui-sm, for transient status messages
 *                ("Loading…", "Cannot display binary file." …)
 */
import { cn } from "@/utils/cn";
import { Button } from "./button";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  disabled?: boolean;
  className?: string;
  /** Typography tone for the title. Defaults to "label" (uppercase). */
  tone?: "label" | "status";
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  disabled = false,
  className,
  tone = "label",
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-3 px-5 py-8 text-center",
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <div className="flex flex-col gap-1">
        <p
          className={cn(
            "text-muted-foreground",
            tone === "label"
              ? "text-small-label uppercase"
              : "text-app-ui-sm",
          )}
        >
          {title}
        </p>
        {description ? (
          <p className="max-w-[260px] text-app-ui-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actionLabel && onAction ? (
        <Button type="button" variant="default" size="sm" onClick={onAction} disabled={disabled}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

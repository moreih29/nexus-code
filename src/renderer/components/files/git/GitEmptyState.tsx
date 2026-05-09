/**
 * GitEmptyState renders centered onboarding or clean-working-tree states.
 */
import { GitBranchPlus } from "lucide-react";
import { Button } from "../../ui/button";

interface GitEmptyStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  disabled?: boolean;
}

export function GitEmptyState({
  title,
  description,
  actionLabel,
  onAction,
  disabled = false,
}: GitEmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-8 text-center">
      <GitBranchPlus
        className="size-7 text-muted-foreground"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <div className="flex flex-col gap-1">
        <p className="text-small-label uppercase text-muted-foreground">{title}</p>
        <p className="max-w-[260px] text-app-ui-sm text-muted-foreground">{description}</p>
      </div>
      {actionLabel && onAction ? (
        <Button type="button" variant="pill" size="sm" onClick={onAction} disabled={disabled}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

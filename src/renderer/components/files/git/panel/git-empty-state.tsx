/**
 * GitEmptyState renders centered onboarding or clean-working-tree states.
 * Delegates to the generic EmptyState primitive from ui/empty-state.
 */
import { GitBranchPlus } from "lucide-react";
import { EmptyState } from "../../../ui/empty-state";

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
    <EmptyState
      icon={<GitBranchPlus className="size-7" strokeWidth={1.5} />}
      title={title}
      description={description}
      actionLabel={actionLabel}
      onAction={onAction}
      disabled={disabled}
    />
  );
}

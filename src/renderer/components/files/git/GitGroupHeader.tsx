/**
 * GitGroupHeader renders an expandable Source Control section heading.
 */
import { ChevronDown, ChevronRight, Minus, Plus, Trash2 } from "lucide-react";
import { Button } from "../../ui/button";

interface GitGroupHeaderProps {
  label: string;
  count: number;
  expanded: boolean;
  stageActionLabel?: string;
  unstageActionLabel?: string;
  discardActionLabel?: string;
  onToggle: () => void;
  onStageAll?: () => void;
  onUnstageAll?: () => void;
  onDiscardAll?: () => void;
}

export function GitGroupHeader({
  label,
  count,
  expanded,
  stageActionLabel,
  unstageActionLabel,
  discardActionLabel,
  onToggle,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
}: GitGroupHeaderProps) {
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="group flex h-7 items-center gap-1 px-2 text-app-ui-sm text-muted-foreground hover:bg-frosted-veil focus-within:bg-frosted-veil">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mist-border focus-visible:ring-inset"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <Chevron className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate uppercase tracking-[0.08em]">{label}</span>
        <span className="shrink-0 rounded bg-frosted-veil-strong px-1 text-app-ui-sm">{count}</span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {onStageAll && stageActionLabel ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label={stageActionLabel}
            title={stageActionLabel}
            onClick={onStageAll}
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
        {onUnstageAll && unstageActionLabel ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label={unstageActionLabel}
            title={unstageActionLabel}
            onClick={onUnstageAll}
          >
            <Minus className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
        {onDiscardAll && discardActionLabel ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6 text-destructive hover:text-destructive"
            aria-label={discardActionLabel}
            title={discardActionLabel}
            onClick={onDiscardAll}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

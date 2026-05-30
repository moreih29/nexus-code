/**
 * GitGroupHeader renders an expandable Source Control section heading.
 */
import { ChevronRight, Minus, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { GitExpandedGroupKey } from "../../../../../shared/git/types";
import { Button } from "../../../ui/button";
import {
  type GitContextMenuPoint,
  GitGroupContextMenu,
  pointFromButtonRect,
  pointFromMouseEvent,
} from "./file-context-menu";

interface GitGroupHeaderProps {
  groupKey: GitExpandedGroupKey;
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
  onAddToGitignore?: () => void;
  onStashGroup?: () => void;
}

export function GitGroupHeader({
  groupKey,
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
  onAddToGitignore,
  onStashGroup,
}: GitGroupHeaderProps) {
  const { t } = useTranslation("files");
  const [contextMenuPoint, setContextMenuPoint] = useState<GitContextMenuPoint | null>(null);

  return (
    <div className="group flex h-7 items-center gap-1 px-2 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] focus-within:bg-[var(--state-hover-bg)]">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        aria-expanded={expanded}
        onClick={onToggle}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenuPoint(pointFromMouseEvent(event));
        }}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 ease-out",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="truncate text-app-label uppercase">{label}</span>
        <span className="shrink-0 rounded bg-muted px-1 text-app-ui-sm">{count}</span>
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
            className="size-6 opacity-50 transition-opacity hover:opacity-100 git-destructive-text"
            aria-label={discardActionLabel}
            title={discardActionLabel}
            onClick={onDiscardAll}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6"
          aria-label={t("git.groups.groupActions", { label })}
          title={t("git.groups.groupActions", { label })}
          aria-haspopup="menu"
          aria-expanded={contextMenuPoint !== null}
          onClick={(event) => {
            event.stopPropagation();
            setContextMenuPoint(pointFromButtonRect(event.currentTarget.getBoundingClientRect()));
          }}
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      <GitGroupContextMenu
        point={contextMenuPoint}
        groupKey={groupKey}
        actions={{
          stageAll: onStageAll,
          unstageAll: onUnstageAll,
          discardAll: onDiscardAll,
          addToGitignore: onAddToGitignore,
          stashGroup: onStashGroup,
        }}
        onClose={() => setContextMenuPoint(null)}
      />
    </div>
  );
}

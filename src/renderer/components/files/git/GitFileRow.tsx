/**
 * GitFileRow renders a changed file with RTL front-truncation and inline actions.
 */
import { Check, ExternalLink, Minus, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../shared/types/git";
import { Button } from "../../ui/button";
import { ROW_HEIGHT_PX } from "../file-tree/file-tree-metrics";
import {
  type GitContextMenuPoint,
  GitFileContextMenu,
  pointFromMouseEvent,
} from "./GitFileContextMenu";
import { GitStatusBadge } from "./GitStatusBadge";
import { formatGitEntryPath, getGitStatusCode } from "./git-status-utils";

interface GitFileRowProps {
  groupKey: GitExpandedGroupKey;
  entry: GitStatusEntry;
  onOpenDiff: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard: () => void;
  onMarkResolved?: () => void;
  onOpenFile?: () => void;
  onRevealInOS?: () => void;
  onCopyPath?: () => void;
  onCopyRelativePath?: () => void;
  onAddToGitignore?: () => void;
}

export function GitFileRow({
  groupKey,
  entry,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
  onMarkResolved,
  onOpenFile,
  onRevealInOS,
  onCopyPath,
  onCopyRelativePath,
  onAddToGitignore,
}: GitFileRowProps) {
  const [contextMenuPoint, setContextMenuPoint] = useState<GitContextMenuPoint | null>(null);
  const pathLabel = formatGitEntryPath(entry);
  const code = getGitStatusCode(groupKey, entry);
  const isConflictRow = groupKey === "merge";
  const toggleStage = groupKey === "staged" ? onUnstage : onStage;
  const toggleLabel = groupKey === "staged" ? "Unstage changes" : "Stage changes";

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === " " && toggleStage) {
      event.preventDefault();
      toggleStage();
    } else if (event.key === "Backspace") {
      event.preventDefault();
      onDiscard();
    }
  }

  return (
    <div
      className="group flex w-full items-center pr-1 hover:bg-frosted-veil-strong focus-within:bg-frosted-veil-strong"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mist-border focus-visible:ring-inset"
        style={{ height: ROW_HEIGHT_PX }}
        title={pathLabel}
        aria-label={`Open diff for ${pathLabel}`}
        onClick={onOpenDiff}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenuPoint(pointFromMouseEvent(event));
        }}
        onKeyDown={handleKeyDown}
      >
        <GitStatusBadge code={code} />
        <span
          className="min-w-0 flex-1 truncate text-app-body text-foreground"
          dir="rtl"
          style={{ textAlign: "left", unicodeBidi: "plaintext" }}
          title={pathLabel}
        >
          {pathLabel}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {isConflictRow ? (
          <>
            {onMarkResolved ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label={`Mark ${entry.relPath} resolved`}
                title={`Mark ${entry.relPath} resolved`}
                onClick={onMarkResolved}
              >
                <Check className="size-3.5" aria-hidden="true" />
              </Button>
            ) : null}
            {onOpenFile ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label={`Open ${entry.relPath} in external editor`}
                title="Open in External Editor"
                onClick={onOpenFile}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </Button>
            ) : null}
          </>
        ) : toggleStage ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label={toggleLabel}
            title={toggleLabel}
            onClick={toggleStage}
          >
            {groupKey === "staged" ? (
              <Minus className="size-3.5" aria-hidden="true" />
            ) : (
              <Plus className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6 git-destructive-text"
          aria-label="Discard changes"
          title="Discard changes"
          onClick={onDiscard}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      {onOpenFile && onRevealInOS && onCopyPath && onCopyRelativePath && onAddToGitignore ? (
        <GitFileContextMenu
          point={contextMenuPoint}
          groupKey={groupKey}
          actions={{
            openFile: onOpenFile,
            openChanges: onOpenDiff,
            markResolved: onMarkResolved,
            stage: onStage,
            unstage: onUnstage,
            discard: onDiscard,
            revealInOS: onRevealInOS,
            copyPath: onCopyPath,
            copyRelativePath: onCopyRelativePath,
            addToGitignore: onAddToGitignore,
          }}
          onClose={() => setContextMenuPoint(null)}
        />
      ) : null}
    </div>
  );
}

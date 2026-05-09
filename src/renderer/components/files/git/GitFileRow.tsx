/**
 * GitFileRow renders a changed file with RTL front-truncation and inline actions.
 */
import { Minus, Plus, Trash2 } from "lucide-react";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../shared/types/git";
import { Button } from "../../ui/button";
import { ROW_HEIGHT_PX } from "../file-tree/file-tree-metrics";
import { GitStatusBadge } from "./GitStatusBadge";
import { formatGitEntryPath, getGitStatusCode } from "./git-status-utils";

interface GitFileRowProps {
  groupKey: GitExpandedGroupKey;
  entry: GitStatusEntry;
  onOpenDiff: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard: () => void;
}

export function GitFileRow({
  groupKey,
  entry,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
}: GitFileRowProps) {
  const pathLabel = formatGitEntryPath(entry);
  const code = getGitStatusCode(groupKey, entry);
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
        {toggleStage ? (
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
          className="size-6 text-destructive hover:text-destructive"
          aria-label="Discard changes"
          title="Discard changes"
          onClick={onDiscard}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

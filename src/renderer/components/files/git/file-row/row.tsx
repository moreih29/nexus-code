/**
 * GitFileRow renders a changed file with RTL front-truncation and inline actions.
 */
import { Check, Minus, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../../shared/git/types";
import { Button } from "../../../ui/button";
import { ROW_HEIGHT_PX } from "../../file-tree/metrics";
import { formatGitEntryPath, getGitStatusCode } from "../utils/status-utils";
import {
  type GitContextMenuPoint,
  GitFileContextMenu,
  pointFromMouseEvent,
} from "./file-context-menu";
import { GitStatusBadge } from "./status-badge";

interface GitFileRowProps {
  groupKey: GitExpandedGroupKey;
  entry: GitStatusEntry;
  /**
   * 호출 측이 결정하는 diff 열기 동작. `opts` 미지정 시 preview(임시) 슬롯
   * 재사용 흐름으로 해석되도록 상위에서 default 처리한다 — 파일트리 single-click
   * 패턴과 동일. 더블클릭 시에는 `{ preview: false }`를 명시해 permanent로 승격.
   */
  onOpenDiff: (opts?: { preview: boolean }) => void;
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
      className="group flex w-full items-center pr-1 hover:bg-[var(--state-hover-bg)] focus-within:bg-[var(--state-hover-bg)]"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 px-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        style={{ height: ROW_HEIGHT_PX }}
        title={pathLabel}
        aria-label={`Open diff for ${pathLabel}`}
        // single click — preview(임시 슬롯) 흐름으로 위임. 더블클릭은 onClick이
        // 먼저 fire되어 preview를 띄운 직후 promote되므로 별도 처리 불필요.
        onClick={() => onOpenDiff()}
        onDoubleClick={() => onOpenDiff({ preview: false })}
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
          onMarkResolved ? (
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
          ) : null
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
          className="size-6 opacity-50 transition-opacity hover:opacity-100 git-destructive-text"
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

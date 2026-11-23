/**
 * GitFileRow renders a changed file with RTL front-truncation and inline actions.
 *
 * Memoized: a panel lists every untracked file, as many as there are, so a
 * row renders only when its own file changes, compared by value, since each
 * status refresh brings new entries for the same files. Its actions come
 * from the panel as one object that keeps its identity, and its context
 * menu is the one the panel shares among its rows.
 */
import { Check, Minus, Plus, Trash2 } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../../shared/git/types";
import { Button } from "../../../ui/button";
import { ROW_HEIGHT_PX } from "../../file-tree/metrics";
import { formatGitEntryPath, getGitStatusCode } from "../utils/status-utils";
import {
  type GitContextMenuPoint,
  type GitFileContextMenuActions,
  pointFromMouseEvent,
} from "./file-context-menu";
import { GitStatusBadge } from "./status-badge";

/** What a file's row does, for any row: the panel gives one, which keeps its identity. */
export interface GitFileActions {
  readonly stage: (paths: string[]) => void;
  readonly unstage: (paths: string[]) => void;
  readonly discard: (paths: string[], description: string, source: GitExpandedGroupKey) => void;
  readonly markResolved: (entry: GitStatusEntry) => void;
  /**
   * Diff-open behavior decided by the caller. When `opts` is not given it is
   * the preview (temporary) slot reuse flow — the same pattern as a file tree
   * single-click. On double-click `{ preview: false }` promotes to permanent.
   */
  readonly openDiff: (
    entry: GitStatusEntry,
    groupKey: GitExpandedGroupKey,
    opts?: { preview: boolean },
  ) => void;
  readonly openFile: (entry: GitStatusEntry) => void;
  readonly revealInOS: (entry: GitStatusEntry) => void;
  readonly copyPath: (entry: GitStatusEntry) => void;
  readonly copyRelativePath: (entry: GitStatusEntry) => void;
  readonly addToGitignore: (entry: GitStatusEntry) => void;
  /**
   * Only looks: no staging, discarding or resolving from a row, its group
   * or its menu. A workspace on another computer's Source Control is.
   */
  readonly readOnly?: boolean;
  /** Opens the panel's file menu for the row at `point`. */
  readonly openMenu: (
    entry: GitStatusEntry,
    groupKey: GitExpandedGroupKey,
    point: GitContextMenuPoint,
  ) => void;
}

/** A conflicted file's row has no stage toggle; a staged one's unstages. */
function canStageIn(groupKey: GitExpandedGroupKey): boolean {
  return groupKey !== "staged" && groupKey !== "merge";
}

/** What the file menu does for the row of `entry` in `groupKey`. */
export function gitFileMenuActions(
  entry: GitStatusEntry,
  groupKey: GitExpandedGroupKey,
  actions: GitFileActions,
): GitFileContextMenuActions {
  if (actions.readOnly) {
    return {
      openFile: () => actions.openFile(entry),
      openChanges: () => actions.openDiff(entry, groupKey),
      copyPath: () => actions.copyPath(entry),
      copyRelativePath: () => actions.copyRelativePath(entry),
    };
  }
  return {
    openFile: () => actions.openFile(entry),
    openChanges: () => actions.openDiff(entry, groupKey),
    markResolved: groupKey === "merge" ? () => actions.markResolved(entry) : undefined,
    stage: canStageIn(groupKey) ? () => actions.stage([entry.relPath]) : undefined,
    unstage: groupKey === "staged" ? () => actions.unstage([entry.relPath]) : undefined,
    discard: () => actions.discard([entry.relPath], entry.relPath, groupKey),
    revealInOS: () => actions.revealInOS(entry),
    copyPath: () => actions.copyPath(entry),
    copyRelativePath: () => actions.copyRelativePath(entry),
    addToGitignore: () => actions.addToGitignore(entry),
  };
}

export interface GitFileRowProps {
  groupKey: GitExpandedGroupKey;
  entry: GitStatusEntry;
  actions: GitFileActions;
}

/** Every field of an entry: one added to the type fails to compile here until compared. */
const ENTRY_FIELDS = {
  relPath: true,
  oldRelPath: true,
  xy: true,
  conflictType: true,
} as const satisfies Record<keyof GitStatusEntry, true>;
const ENTRY_KEYS = Object.keys(ENTRY_FIELDS) as (keyof GitStatusEntry)[];

/** A row shows nothing but its entry's fields, so an equal entry renders the same row. */
export function sameGitFileRow(prev: GitFileRowProps, next: GitFileRowProps): boolean {
  return (
    prev.groupKey === next.groupKey &&
    prev.actions === next.actions &&
    ENTRY_KEYS.every((key) => prev.entry[key] === next.entry[key])
  );
}

export const GitFileRow = memo(function GitFileRow({ groupKey, entry, actions }: GitFileRowProps) {
  const { t } = useTranslation("files");
  const pathLabel = formatGitEntryPath(entry);
  const code = getGitStatusCode(groupKey, entry);
  const isConflictRow = groupKey === "merge";
  const writes = !actions.readOnly;
  const onStage = writes && canStageIn(groupKey) ? () => actions.stage([entry.relPath]) : undefined;
  const onUnstage =
    writes && groupKey === "staged" ? () => actions.unstage([entry.relPath]) : undefined;
  const onDiscard = writes
    ? () => actions.discard([entry.relPath], entry.relPath, groupKey)
    : undefined;
  const onMarkResolved = writes && isConflictRow ? () => actions.markResolved(entry) : undefined;
  const onOpenDiff = (opts?: { preview: boolean }) => actions.openDiff(entry, groupKey, opts);
  const toggleStage = groupKey === "staged" ? onUnstage : onStage;
  const toggleLabel =
    groupKey === "staged" ? t("git.fileRow.unstageChanges") : t("git.fileRow.stageChanges");
  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === " " && toggleStage) {
      event.preventDefault();
      toggleStage();
    } else if (event.key === "Backspace" && onDiscard) {
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
        aria-label={t("git.fileRow.openDiff", { path: pathLabel })}
        // single click — delegates to the preview (temporary slot) flow. On a double-click
        // onClick fires first and opens the preview, which is promoted right after, so no
        // separate handling is needed.
        onClick={() => onOpenDiff()}
        onDoubleClick={() => onOpenDiff({ preview: false })}
        onContextMenu={(event) => {
          event.preventDefault();
          actions.openMenu(entry, groupKey, pointFromMouseEvent(event));
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
      {onDiscard && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {isConflictRow ? (
            onMarkResolved ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label={t("git.fileRow.markResolved", { path: entry.relPath })}
                title={t("git.fileRow.markResolved", { path: entry.relPath })}
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
            aria-label={t("git.fileRow.discardChanges")}
            title={t("git.fileRow.discardChanges")}
            onClick={onDiscard}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}, sameGitFileRow);

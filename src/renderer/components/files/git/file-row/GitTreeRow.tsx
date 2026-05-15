/**
 * GitTreeRow renders a single row in the Source Control tree view.
 *
 * - dir rows: collapsible folder with chevron + folder icon + displayName + child count.
 *   On hover, inline stage/unstage/discard actions appear (VS Code SCM equivalent).
 * - leaf rows: wraps GitFileRow with an indent offset applied via paddingLeft.
 *
 * WAI-ARIA tree semantics and roving tabindex are delegated to the caller via
 * the `treeItemProps` spread (role="treeitem", tabIndex, aria-expanded, etc.)
 * so this component stays focused on visual rendering only.
 */
import { ChevronDown, ChevronRight, Folder, FolderOpen, Minus, Plus, Trash2 } from "lucide-react";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../../shared/types/git";
import { Button } from "../../../ui/button";
import { INDENT_STEP_PX } from "../../file-tree/file-tree-metrics";
import { GitFileRow } from "./GitFileRow";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitTreeRowBase {
  /** Depth in the tree (root children are depth 1). */
  depth: number;
  groupKey: GitExpandedGroupKey;
  /** Extra props spread onto the treeitem element for WAI-ARIA + roving tabindex. */
  treeItemProps: React.HTMLAttributes<HTMLElement>;
  onFocus?: () => void;
}

interface GitTreeRowDirProps extends GitTreeRowBase {
  kind: "dir";
  displayName: string;
  relPath: string;
  isExpanded: boolean;
  childCount: number;
  onToggle: () => void;
  /** Called when the user clicks the stage (plus) action on a dir row. */
  onStagePaths?: () => void;
  /** Called when the user clicks the unstage (minus) action on a dir row. */
  onUnstagePaths?: () => void;
  /** Called when the user clicks the discard (trash) action on a dir row. */
  onDiscardPaths?: () => void;
}

interface GitTreeRowLeafProps extends GitTreeRowBase {
  kind: "leaf";
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

export type GitTreeRowProps = GitTreeRowDirProps | GitTreeRowLeafProps;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GitTreeRow(props: GitTreeRowProps) {
  const { depth, treeItemProps, onFocus } = props;
  const indentLeft = (depth - 1) * INDENT_STEP_PX + 8;

  if (props.kind === "dir") {
    const {
      displayName,
      isExpanded,
      childCount,
      onToggle,
      onStagePaths,
      onUnstagePaths,
      onDiscardPaths,
    } = props;
    const Chevron = isExpanded ? ChevronDown : ChevronRight;
    const FolderIcon = isExpanded ? FolderOpen : Folder;

    return (
      <div
        {...treeItemProps}
        role="treeitem"
        aria-expanded={isExpanded}
        className="group flex h-6 w-full cursor-pointer items-center gap-1 pr-1 text-app-body text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-mist-border"
        style={{ paddingLeft: indentLeft }}
        onClick={onToggle}
        onFocus={onFocus}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        tabIndex={treeItemProps.tabIndex ?? -1}
      >
        <Chevron className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{displayName}</span>
        {/* Inline actions — visible on hover/focus-within, hidden otherwise */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {onStagePaths ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label={`Stage folder ${displayName}`}
              title={`Stage folder ${displayName}`}
              onClick={(event) => {
                event.stopPropagation();
                onStagePaths();
              }}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          {onUnstagePaths ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label={`Unstage folder ${displayName}`}
              title={`Unstage folder ${displayName}`}
              onClick={(event) => {
                event.stopPropagation();
                onUnstagePaths();
              }}
            >
              <Minus className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          {onDiscardPaths ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6 git-destructive-text"
              aria-label={`Discard changes in folder ${displayName}`}
              title={`Discard changes in folder ${displayName}`}
              onClick={(event) => {
                event.stopPropagation();
                onDiscardPaths();
              }}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        <span className="shrink-0 rounded bg-frosted-veil-strong px-1 text-app-ui-sm text-muted-foreground">
          {childCount}
        </span>
      </div>
    );
  }

  // Leaf: wrap GitFileRow with indentation override.
  const {
    entry,
    groupKey,
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
  } = props;

  return (
    <div
      {...treeItemProps}
      role="treeitem"
      style={{ paddingLeft: indentLeft }}
      onFocus={onFocus}
      tabIndex={treeItemProps.tabIndex ?? -1}
    >
      <GitFileRow
        groupKey={groupKey}
        entry={entry}
        onOpenDiff={onOpenDiff}
        onStage={onStage}
        onUnstage={onUnstage}
        onDiscard={onDiscard}
        onMarkResolved={onMarkResolved}
        onOpenFile={onOpenFile}
        onRevealInOS={onRevealInOS}
        onCopyPath={onCopyPath}
        onCopyRelativePath={onCopyRelativePath}
        onAddToGitignore={onAddToGitignore}
      />
    </div>
  );
}

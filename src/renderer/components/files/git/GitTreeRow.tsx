/**
 * GitTreeRow renders a single row in the Source Control tree view.
 *
 * - dir rows: collapsible folder with chevron + folder icon + displayName + child count.
 * - leaf rows: wraps GitFileRow with an indent offset applied via paddingLeft.
 *
 * WAI-ARIA tree semantics and roving tabindex are delegated to the caller via
 * the `treeItemProps` spread (role="treeitem", tabIndex, aria-expanded, etc.)
 * so this component stays focused on visual rendering only.
 */
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../shared/types/git";
import { INDENT_STEP_PX } from "../file-tree/file-tree-metrics";
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
}

interface GitTreeRowLeafProps extends GitTreeRowBase {
  kind: "leaf";
  entry: GitStatusEntry;
  onOpenDiff: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard: () => void;
}

export type GitTreeRowProps = GitTreeRowDirProps | GitTreeRowLeafProps;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GitTreeRow(props: GitTreeRowProps) {
  const { depth, treeItemProps, onFocus } = props;
  const indentLeft = (depth - 1) * INDENT_STEP_PX + 8;

  if (props.kind === "dir") {
    const { displayName, isExpanded, childCount, onToggle } = props;
    const Chevron = isExpanded ? ChevronDown : ChevronRight;
    const FolderIcon = isExpanded ? FolderOpen : Folder;

    return (
      <div
        {...treeItemProps}
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
        <span className="shrink-0 rounded bg-frosted-veil-strong px-1 text-app-ui-sm text-muted-foreground">
          {childCount}
        </span>
      </div>
    );
  }

  // Leaf: wrap GitFileRow with indentation override.
  const { entry, groupKey, onOpenDiff, onStage, onUnstage, onDiscard } = props;

  return (
    <div
      {...treeItemProps}
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
      />
    </div>
  );
}

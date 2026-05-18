/**
 * GitGroup renders one non-empty Source Control section and its file rows.
 *
 * - list mode: renders GitFileRow per entry (original behaviour).
 * - tree mode: builds a path tree from entry relPaths, renders GitTreeRow
 *   recursively with WAI-ARIA tree role and roving tabindex.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../../shared/git/types";
import type { ViewMode } from "../../../../../shared/types/panel";
import {
  buildPathTree,
  collectDescendantLeafPaths,
  compactPathTree,
  type PathTreeNode,
} from "../../file-tree/tree-builder";
import type { TreeKeyboardRow } from "../../file-tree/use-tree-keyboard";
import { useTreeKeyboard } from "../../file-tree/use-tree-keyboard";
import { collectGitEntryPaths } from "../utils/status-utils";
import { GitFileRow } from "./row";
import { GitGroupHeader } from "./group-header";
import { GitTreeRow } from "./tree-row";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitGroupProps {
  groupKey: GitExpandedGroupKey;
  label: string;
  entries: GitStatusEntry[];
  expanded: boolean;
  viewMode?: ViewMode;
  compactFolders?: boolean;
  /** relPaths of expanded tree nodes for this group */
  expandedTreeNodes?: string[];
  onToggle: () => void;
  onToggleTreeNode?: (relPath: string) => void;
  onStagePaths: (paths: string[]) => void;
  onUnstagePaths: (paths: string[]) => void;
  onDiscardPaths: (paths: string[], description: string, source: GitExpandedGroupKey) => void;
  onMarkResolved: (entry: GitStatusEntry) => void;
  onOpenDiff: (entry: GitStatusEntry, groupKey: GitExpandedGroupKey) => void;
  onOpenFile: (entry: GitStatusEntry) => void;
  onRevealInOS: (entry: GitStatusEntry) => void;
  onCopyPath: (entry: GitStatusEntry) => void;
  onCopyRelativePath: (entry: GitStatusEntry) => void;
  onAddToGitignore: (entry: GitStatusEntry) => void;
  onAddPathsToGitignore: (paths: string[]) => void;
  onStashGroup: (paths: string[], label: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FlatRow {
  node: PathTreeNode;
  /** Index into the flat rows array — for keyboard navigation. */
  index: number;
  parentRelPath: string;
}

/**
 * Flatten a tree into a pre-order list, skipping children of collapsed dirs.
 */
function flattenTree(
  nodes: PathTreeNode[],
  expandedSet: Set<string>,
  parentRelPath: string,
  result: FlatRow[],
): void {
  for (const node of nodes) {
    result.push({ node, index: result.length, parentRelPath });
    if (node.kind === "dir" && expandedSet.has(node.relPath) && node.children) {
      flattenTree(node.children, expandedSet, node.relPath, result);
    }
  }
}

/** Count the leaf (file) descendants of a dir node. */
function countLeaves(node: PathTreeNode): number {
  if (node.kind === "file") return 1;
  if (!node.children) return 0;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GitGroup({
  groupKey,
  label,
  entries,
  expanded,
  viewMode = "list",
  compactFolders = false,
  expandedTreeNodes = [],
  onToggle,
  onToggleTreeNode,
  onStagePaths,
  onUnstagePaths,
  onDiscardPaths,
  onMarkResolved,
  onOpenDiff,
  onOpenFile,
  onRevealInOS,
  onCopyPath,
  onCopyRelativePath,
  onAddToGitignore,
  onAddPathsToGitignore,
  onStashGroup,
}: GitGroupProps) {
  if (entries.length === 0) return null;

  const paths = collectGitEntryPaths(entries);
  const canStageRows = groupKey !== "staged" && groupKey !== "merge";
  const canStageHeader = groupKey === "working" || groupKey === "untracked";
  const canUnstage = groupKey === "staged";
  const canDiscardHeader = groupKey === "working";
  const discardLabel = `Discard all ${label.toLowerCase()}`;

  const header = (
    <GitGroupHeader
      groupKey={groupKey}
      label={label}
      count={entries.length}
      expanded={expanded}
      onToggle={onToggle}
      stageActionLabel={canStageHeader ? `Stage all ${label.toLowerCase()}` : undefined}
      unstageActionLabel={canUnstage ? "Unstage all staged changes" : undefined}
      discardActionLabel={canDiscardHeader ? discardLabel : undefined}
      onStageAll={canStageHeader ? () => onStagePaths(paths) : undefined}
      onUnstageAll={canUnstage ? () => onUnstagePaths(paths) : undefined}
      onDiscardAll={canDiscardHeader ? () => onDiscardPaths(paths, label, groupKey) : undefined}
      onAddToGitignore={groupKey !== "merge" ? () => onAddPathsToGitignore(paths) : undefined}
      onStashGroup={groupKey !== "merge" ? () => onStashGroup(paths, label) : undefined}
    />
  );

  if (!expanded) {
    return <section aria-label={label}>{header}</section>;
  }

  if (viewMode === "list") {
    return (
      <section aria-label={label}>
        {header}
        <div>
          {entries.map((entry) => (
            <GitFileRow
              key={`${groupKey}:${entry.oldRelPath ?? ""}:${entry.relPath}`}
              groupKey={groupKey}
              entry={entry}
              onOpenDiff={() => onOpenDiff(entry, groupKey)}
              onStage={canStageRows ? () => onStagePaths([entry.relPath]) : undefined}
              onUnstage={canUnstage ? () => onUnstagePaths([entry.relPath]) : undefined}
              onDiscard={() => onDiscardPaths([entry.relPath], entry.relPath, groupKey)}
              onMarkResolved={groupKey === "merge" ? () => onMarkResolved(entry) : undefined}
              onOpenFile={() => onOpenFile(entry)}
              onRevealInOS={() => onRevealInOS(entry)}
              onCopyPath={() => onCopyPath(entry)}
              onCopyRelativePath={() => onCopyRelativePath(entry)}
              onAddToGitignore={() => onAddToGitignore(entry)}
            />
          ))}
        </div>
      </section>
    );
  }

  // tree mode — delegate to sub-component to keep hook rules clean.
  return (
    <section aria-label={label}>
      {header}
      <GitGroupTree
        groupKey={groupKey}
        entries={entries}
        compactFolders={compactFolders}
        expandedTreeNodes={expandedTreeNodes}
        onToggleTreeNode={onToggleTreeNode}
        canStage={canStageRows}
        canUnstage={canUnstage}
        onStagePaths={onStagePaths}
        onUnstagePaths={onUnstagePaths}
        onDiscardPaths={onDiscardPaths}
        onMarkResolved={onMarkResolved}
        onOpenDiff={onOpenDiff}
        onOpenFile={onOpenFile}
        onRevealInOS={onRevealInOS}
        onCopyPath={onCopyPath}
        onCopyRelativePath={onCopyRelativePath}
        onAddToGitignore={onAddToGitignore}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// GitGroupTree — tree-mode body (extracted so hooks are called unconditionally)
// ---------------------------------------------------------------------------

interface GitGroupTreeProps {
  groupKey: GitExpandedGroupKey;
  entries: GitStatusEntry[];
  compactFolders: boolean;
  expandedTreeNodes: string[];
  onToggleTreeNode?: (relPath: string) => void;
  canStage: boolean;
  canUnstage: boolean;
  onStagePaths: (paths: string[]) => void;
  onUnstagePaths: (paths: string[]) => void;
  onDiscardPaths: (paths: string[], description: string, source: GitExpandedGroupKey) => void;
  onMarkResolved: (entry: GitStatusEntry) => void;
  onOpenDiff: (entry: GitStatusEntry, groupKey: GitExpandedGroupKey) => void;
  onOpenFile: (entry: GitStatusEntry) => void;
  onRevealInOS: (entry: GitStatusEntry) => void;
  onCopyPath: (entry: GitStatusEntry) => void;
  onCopyRelativePath: (entry: GitStatusEntry) => void;
  onAddToGitignore: (entry: GitStatusEntry) => void;
}

function GitGroupTree({
  groupKey,
  entries,
  compactFolders,
  expandedTreeNodes,
  onToggleTreeNode,
  canStage,
  canUnstage,
  onStagePaths,
  onUnstagePaths,
  onDiscardPaths,
  onMarkResolved,
  onOpenDiff,
  onOpenFile,
  onRevealInOS,
  onCopyPath,
  onCopyRelativePath,
  onAddToGitignore,
}: GitGroupTreeProps) {
  // Build entry lookup by relPath for leaf actions.
  const entryByRelPath = useMemo(() => {
    const map = new Map<string, GitStatusEntry>();
    for (const e of entries) map.set(e.relPath, e);
    return map;
  }, [entries]);

  // Build path tree.
  const tree = useMemo(() => {
    const relPaths = entries.map((e) => e.relPath);
    const raw = buildPathTree(relPaths);
    return compactFolders ? compactPathTree(raw) : raw;
  }, [entries, compactFolders]);

  const expandedSet = useMemo(() => new Set(expandedTreeNodes), [expandedTreeNodes]);

  // Flatten visible rows.
  const flatRows = useMemo(() => {
    const result: FlatRow[] = [];
    if (tree.children) {
      flattenTree(tree.children, expandedSet, "", result);
    }
    return result;
  }, [tree, expandedSet]);

  // Build TreeKeyboardRow array for the hook.
  const keyboardRows = useMemo<TreeKeyboardRow[]>(
    () =>
      flatRows.map((r) => ({
        kind: r.node.kind === "dir" ? "dir" : "leaf",
        relPath: r.node.relPath,
        isExpanded: r.node.kind === "dir" ? expandedSet.has(r.node.relPath) : undefined,
        parentRelPath: r.parentRelPath,
      })),
    [flatRows, expandedSet],
  );

  const [focusedIndex, setFocusedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleToggle = useCallback(
    (relPath: string) => {
      onToggleTreeNode?.(relPath);
    },
    [onToggleTreeNode],
  );

  const handleActivate = useCallback(
    (row: TreeKeyboardRow) => {
      const entry = entryByRelPath.get(row.relPath);
      if (entry) onOpenDiff(entry, groupKey);
    },
    [entryByRelPath, groupKey, onOpenDiff],
  );

  const { onKeyDown, getRowProps } = useTreeKeyboard({
    rows: keyboardRows,
    focusedIndex,
    onMove: setFocusedIndex,
    onToggle: handleToggle,
    onActivate: handleActivate,
  });

  if (flatRows.length === 0) return null;

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label={groupKey}
      onKeyDown={(e) => onKeyDown(e.nativeEvent)}
    >
      {flatRows.map((row, idx) => {
        const { node } = row;
        const rowProps = getRowProps(idx);

        if (node.kind === "dir") {
          const leafPaths = collectDescendantLeafPaths(node);
          return (
            <GitTreeRow
              key={node.relPath}
              kind="dir"
              depth={node.depth}
              groupKey={groupKey}
              displayName={node.displayName}
              relPath={node.relPath}
              isExpanded={expandedSet.has(node.relPath)}
              childCount={countLeaves(node)}
              treeItemProps={rowProps}
              onFocus={() => setFocusedIndex(idx)}
              onToggle={() => handleToggle(node.relPath)}
              onStagePaths={canStage ? () => onStagePaths(leafPaths) : undefined}
              onUnstagePaths={canUnstage ? () => onUnstagePaths(leafPaths) : undefined}
              onDiscardPaths={() => onDiscardPaths(leafPaths, node.displayName, groupKey)}
            />
          );
        }

        // leaf
        const entry = entryByRelPath.get(node.relPath);
        if (!entry) return null;

        return (
          <GitTreeRow
            key={`${groupKey}:${entry.oldRelPath ?? ""}:${entry.relPath}`}
            kind="leaf"
            depth={node.depth}
            groupKey={groupKey}
            entry={entry}
            treeItemProps={rowProps}
            onFocus={() => setFocusedIndex(idx)}
            onOpenDiff={() => onOpenDiff(entry, groupKey)}
            onStage={canStage ? () => onStagePaths([entry.relPath]) : undefined}
            onUnstage={canUnstage ? () => onUnstagePaths([entry.relPath]) : undefined}
            onDiscard={() => onDiscardPaths([entry.relPath], entry.relPath, groupKey)}
            onMarkResolved={groupKey === "merge" ? () => onMarkResolved(entry) : undefined}
            onOpenFile={() => onOpenFile(entry)}
            onRevealInOS={() => onRevealInOS(entry)}
            onCopyPath={() => onCopyPath(entry)}
            onCopyRelativePath={() => onCopyRelativePath(entry)}
            onAddToGitignore={() => onAddToGitignore(entry)}
          />
        );
      })}
    </div>
  );
}

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../../shared/git/types";
import type { ViewMode } from "../../../../../shared/types/panel";
import {
  buildPathTree,
  collectDescendantLeafPaths,
  type PathTreeNode,
} from "../../../../utils/path-tree";
import { type GitDecorationKind, kindFromEntry, maxKind } from "../../file-tree/git-decoration";
import type { TreeKeyboardRow } from "../../file-tree/use-tree-keyboard";
import { useTreeKeyboard } from "../../file-tree/use-tree-keyboard";
import { collectGitEntryPaths } from "../utils/status-utils";
import { GitGroupHeader } from "./group-header";
import { type GitFileActions, GitFileRow } from "./row";
import { GitTreeRow } from "./tree-row";

export interface GitGroupActions extends GitFileActions {
  readonly toggleGroup: (key: GitExpandedGroupKey) => void;
  readonly toggleTreeNode: (key: GitExpandedGroupKey, relPath: string) => void;
  readonly addPathsToGitignore: (paths: string[]) => void;
  readonly stashGroup: (paths: string[], label: string) => void;
}

interface GitGroupProps {
  groupKey: GitExpandedGroupKey;
  label: string;
  entries: GitStatusEntry[];
  expanded: boolean;
  viewMode?: ViewMode;
  expandedTreeNodes?: string[];
  actions: GitGroupActions;
}

const NO_EXPANDED_NODES: string[] = [];

interface FlatRow {
  node: PathTreeNode;
  index: number;
  parentRelPath: string;
}

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

function dominantKindForDir(
  node: PathTreeNode,
  entryByRelPath: Map<string, GitStatusEntry>,
): GitDecorationKind | undefined {
  let result: GitDecorationKind | undefined;
  const visit = (n: PathTreeNode): void => {
    if (n.kind === "file") {
      const entry = entryByRelPath.get(n.relPath);
      if (!entry) return;
      const kind = kindFromEntry(entry);
      if (kind === null) return;
      result = result === undefined ? kind : maxKind(result, kind);
      return;
    }
    if (n.children) {
      for (const child of n.children) visit(child);
    }
  };
  visit(node);
  return result;
}

export const GitGroup = memo(function GitGroup({
  groupKey,
  label,
  entries,
  expanded,
  viewMode = "list",
  expandedTreeNodes = NO_EXPANDED_NODES,
  actions,
}: GitGroupProps) {
  const { t } = useTranslation("files");
  if (entries.length === 0) return null;

  const paths = collectGitEntryPaths(entries);
  const writes = !actions.readOnly;
  const canStageRows = writes && groupKey !== "staged" && groupKey !== "merge";
  const canStageHeader = writes && (groupKey === "working" || groupKey === "untracked");
  const canUnstage = writes && groupKey === "staged";
  const canDiscardHeader = writes && groupKey === "working";
  const discardLabel = t("git.groups.discardAll", { label: label.toLowerCase() });

  const header = (
    <GitGroupHeader
      groupKey={groupKey}
      label={label}
      count={entries.length}
      expanded={expanded}
      onToggle={() => actions.toggleGroup(groupKey)}
      readOnly={!writes}
      stageActionLabel={
        canStageHeader ? t("git.groups.stageAll", { label: label.toLowerCase() }) : undefined
      }
      unstageActionLabel={canUnstage ? t("git.groups.unstageAll") : undefined}
      discardActionLabel={canDiscardHeader ? discardLabel : undefined}
      onStageAll={canStageHeader ? () => actions.stage(paths) : undefined}
      onUnstageAll={canUnstage ? () => actions.unstage(paths) : undefined}
      onDiscardAll={canDiscardHeader ? () => actions.discard(paths, label, groupKey) : undefined}
      onAddToGitignore={
        writes && groupKey !== "merge" ? () => actions.addPathsToGitignore(paths) : undefined
      }
      onStashGroup={
        writes && groupKey !== "merge" ? () => actions.stashGroup(paths, label) : undefined
      }
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
              actions={actions}
            />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section aria-label={label}>
      {header}
      <GitGroupTree
        groupKey={groupKey}
        label={label}
        entries={entries}
        expandedTreeNodes={expandedTreeNodes}
        canStage={canStageRows}
        canUnstage={canUnstage}
        actions={actions}
      />
    </section>
  );
});

interface GitGroupTreeProps {
  groupKey: GitExpandedGroupKey;
  label: string;
  entries: GitStatusEntry[];
  expandedTreeNodes: string[];
  canStage: boolean;
  canUnstage: boolean;
  actions: GitGroupActions;
}

function GitGroupTree({
  groupKey,
  label,
  entries,
  expandedTreeNodes,
  canStage,
  canUnstage,
  actions,
}: GitGroupTreeProps) {
  const entryByRelPath = useMemo(() => {
    const map = new Map<string, GitStatusEntry>();
    for (const e of entries) map.set(e.relPath, e);
    return map;
  }, [entries]);

  const tree = useMemo(() => {
    const relPaths = entries.map((e) => e.relPath);
    return buildPathTree(relPaths);
  }, [entries]);

  const expandedSet = useMemo(() => new Set(expandedTreeNodes), [expandedTreeNodes]);

  const flatRows = useMemo(() => {
    const result: FlatRow[] = [];
    if (tree.children) {
      flattenTree(tree.children, expandedSet, "", result);
    }
    return result;
  }, [tree, expandedSet]);

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
      actions.toggleTreeNode(groupKey, relPath);
    },
    [actions, groupKey],
  );

  const handleActivate = useCallback(
    (row: TreeKeyboardRow) => {
      const entry = entryByRelPath.get(row.relPath);
      if (entry) actions.openDiff(entry, groupKey);
    },
    [entryByRelPath, groupKey, actions],
  );

  const focusAfterMoveRef = useRef(false);
  const handleMove = useCallback((next: number) => {
    focusAfterMoveRef.current = true;
    setFocusedIndex(next);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the move has re-rendered the roving tabindex
  useEffect(() => {
    if (!focusAfterMoveRef.current) return;
    focusAfterMoveRef.current = false;
    containerRef.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
  }, [focusedIndex]);

  const { onKeyDown, getRowProps } = useTreeKeyboard({
    rows: keyboardRows,
    focusedIndex,
    onMove: handleMove,
    onToggle: handleToggle,
    onActivate: handleActivate,
  });

  if (flatRows.length === 0) return null;

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label={label}
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
              decoration={dominantKindForDir(node, entryByRelPath)}
              treeItemProps={rowProps}
              onFocus={() => setFocusedIndex(idx)}
              onToggle={() => handleToggle(node.relPath)}
              onStagePaths={canStage ? () => actions.stage(leafPaths) : undefined}
              onUnstagePaths={canUnstage ? () => actions.unstage(leafPaths) : undefined}
              onDiscardPaths={
                actions.readOnly
                  ? undefined
                  : () => actions.discard(leafPaths, node.displayName, groupKey)
              }
            />
          );
        }

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
            actions={actions}
          />
        );
      })}
    </div>
  );
}

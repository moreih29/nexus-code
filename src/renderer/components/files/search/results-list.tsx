/**
 * Virtualized search results list — supports both list and tree view modes.
 *
 * List mode (default):
 *   Builds a flat row array from FileGroup[] + expanded state using:
 *     { kind: "file",  group }
 *     { kind: "match", group, matchIdx }
 *
 * Tree mode:
 *   Builds a directory tree via buildPathTree, then produces a flat ordered
 *   row array including dir rows:
 *     { kind: "dir",   node, matchCount }
 *     { kind: "file",  group }
 *     { kind: "match", group, matchIdx }
 *
 * WAI-ARIA tree role + roving tabindex applied in tree mode via useTreeKeyboard.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { revealEditorAt } from "@/services/editor/tabs";
import type { FileGroup } from "../../../state/stores/search";
import { ROW_HEIGHT_PX } from "../file-tree/metrics";
import type { PathTreeNode } from "../file-tree/tree-builder";
import { buildPathTree } from "../file-tree/tree-builder";
import type { TreeKeyboardRow } from "../file-tree/use-tree-keyboard";
import { useTreeKeyboard } from "../file-tree/use-tree-keyboard";
import { SearchResultFileRow } from "./result-file-row";
import { SearchResultMatchRow } from "./result-match-row";

// Stable empty fallback for the optional `expandedDirs` prop. A parameter
// default of `= new Set()` would create a fresh Set on every render where
// the prop is undefined, invalidating downstream `useMemo` deps every tick.
// Read-only by convention (consumers only call `.has()`).
const EMPTY_EXPANDED_DIRS: ReadonlySet<string> = new Set<string>();

// ---------------------------------------------------------------------------
// Flat row types
// ---------------------------------------------------------------------------

type FlatRow =
  | { kind: "file"; group: FileGroup }
  | { kind: "match"; group: FileGroup; matchIdx: number }
  | { kind: "dir"; node: PathTreeNode; matchCount: number };

// ---------------------------------------------------------------------------
// List-mode flat row builder
// ---------------------------------------------------------------------------

function buildListRows(results: FileGroup[]): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const group of results) {
    rows.push({ kind: "file", group });
    if (group.expanded) {
      for (let i = 0; i < group.matches.length; i++) {
        rows.push({ kind: "match", group, matchIdx: i });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Tree-mode flat row builder
// ---------------------------------------------------------------------------

/**
 * Accumulate match counts from the search results onto each dir node so that
 * dirs show "dirName (N)" without a separate traversal at render time.
 */
function accumulateMatchCounts(node: PathTreeNode, matchMap: Map<string, number>): number {
  if (node.kind === "file") {
    return matchMap.get(node.relPath) ?? 0;
  }
  let total = 0;
  for (const child of node.children ?? []) {
    total += accumulateMatchCounts(child, matchMap);
  }
  return total;
}

/**
 * Walk the tree depth-first and emit rows in display order. Collapsed dirs
 * skip their subtrees. `matchCountMap` is pre-populated by callers.
 */
function walkTreeRows(
  node: PathTreeNode,
  expandedDirs: ReadonlySet<string>,
  matchCountMap: Map<string, number>,
  rows: FlatRow[],
  groupByPath: Map<string, FileGroup>,
  parentRelPath: string,
): void {
  for (const child of node.children ?? []) {
    if (child.kind === "dir") {
      const mc = matchCountMap.get(child.relPath) ?? 0;
      rows.push({ kind: "dir", node: child, matchCount: mc });
      if (expandedDirs.has(child.relPath)) {
        walkTreeRows(child, expandedDirs, matchCountMap, rows, groupByPath, child.relPath);
      }
    } else {
      // File leaf node.
      const group = groupByPath.get(child.relPath);
      if (!group) continue;
      rows.push({ kind: "file", group });
      if (group.expanded) {
        for (let i = 0; i < group.matches.length; i++) {
          rows.push({ kind: "match", group, matchIdx: i });
        }
      }
    }
  }
}

function buildTreeRows(
  results: FileGroup[],
  expandedDirs: ReadonlySet<string>,
): FlatRow[] {
  if (results.length === 0) return [];

  const relPaths = results.map((g) => g.relPath);
  const tree = buildPathTree(relPaths);

  // Map relPath → FileGroup for O(1) lookup during walk.
  const groupByPath = new Map<string, FileGroup>(results.map((g) => [g.relPath, g]));

  // Build match count map: each file node gets the group's match count; dir nodes
  // get the accumulated sum.
  const leafMatchMap = new Map<string, number>(results.map((g) => [g.relPath, g.matches.length]));
  const dirMatchCountMap = new Map<string, number>();

  function fillCounts(node: PathTreeNode): number {
    if (node.kind === "file") {
      return leafMatchMap.get(node.relPath) ?? 0;
    }
    let total = 0;
    for (const child of node.children ?? []) {
      total += fillCounts(child);
    }
    dirMatchCountMap.set(node.relPath, total);
    return total;
  }
  fillCounts(tree);

  const rows: FlatRow[] = [];
  walkTreeRows(tree, expandedDirs, dirMatchCountMap, rows, groupByPath, "");
  return rows;
}

// ---------------------------------------------------------------------------
// Row → TreeKeyboardRow adapter
// ---------------------------------------------------------------------------

function toKeyboardRow(row: FlatRow, expandedDirs: ReadonlySet<string>): TreeKeyboardRow {
  if (row.kind === "dir") {
    return {
      kind: "dir",
      relPath: row.node.relPath,
      isExpanded: expandedDirs.has(row.node.relPath),
    };
  }
  if (row.kind === "file") {
    return {
      kind: "file",
      relPath: row.group.relPath,
      isExpanded: row.group.expanded,
    };
  }
  // match
  return {
    kind: "match",
    relPath: `${row.group.relPath}:${row.matchIdx}`,
    parentRelPath: row.group.relPath,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SearchResultsListProps {
  workspaceId: string;
  rootPath: string;
  results: FileGroup[];
  onToggleGroup: (relPath: string) => void;
  /** When provided, tree mode is active. */
  viewMode?: "list" | "tree";
  expandedDirs?: ReadonlySet<string>;
  onToggleDir?: (relPath: string) => void;
  /** Ref to expose the first-row focus method to the parent (SearchPanel). */
  firstRowFocusRef?: React.MutableRefObject<(() => void) | null>;
}

export function SearchResultsList({
  workspaceId,
  rootPath,
  results,
  onToggleGroup,
  viewMode = "list",
  expandedDirs = EMPTY_EXPANDED_DIRS,
  onToggleDir,
  firstRowFocusRef,
}: SearchResultsListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<number, HTMLElement>>(new Map());
  const [focusedIndex, setFocusedIndex] = useState(0);

  const isTree = viewMode === "tree";

  // Build flat rows — memoised on the inputs that can change their content.
  const flatRows = useMemo<FlatRow[]>(() => {
    if (!isTree) return buildListRows(results);
    return buildTreeRows(results, expandedDirs);
  }, [results, isTree, expandedDirs]);

  // Convert to TreeKeyboardRow for the keyboard hook.
  const keyboardRows = useMemo<TreeKeyboardRow[]>(
    () => flatRows.map((r) => toKeyboardRow(r, expandedDirs)),
    [flatRows, expandedDirs],
  );

  const handleMove = useCallback((next: number) => {
    setFocusedIndex(next);
    // Scroll the virtualizer row into view and shift DOM focus.
    rowRefs.current.get(next)?.focus();
  }, []);

  const handleToggle = useCallback(
    (relPath: string, expanded: boolean) => {
      // Determine whether this is a dir or a file row.
      const row = flatRows.find(
        (r) =>
          (r.kind === "dir" && r.node.relPath === relPath) ||
          (r.kind === "file" && r.group.relPath === relPath),
      );
      if (!row) return;
      if (row.kind === "dir") {
        onToggleDir?.(relPath);
      } else {
        onToggleGroup(relPath);
      }
    },
    [flatRows, onToggleDir, onToggleGroup],
  );

  const handleActivate = useCallback(
    (row: TreeKeyboardRow) => {
      if (row.kind === "match") {
        // relPath for match is "filePath:matchIdx"
        const colonIdx = row.relPath.lastIndexOf(":");
        if (colonIdx === -1) return;
        const filePath = row.relPath.slice(0, colonIdx);
        const idx = parseInt(row.relPath.slice(colonIdx + 1), 10);
        const group = results.find((g) => g.relPath === filePath);
        if (!group) return;
        const match = group.matches[idx];
        if (!match) return;
        const absPath = rootPath.endsWith("/")
          ? `${rootPath}${filePath}`
          : `${rootPath}/${filePath}`;
        revealEditorAt(
          { workspaceId, filePath: absPath },
          {
            selection: {
              startLineNumber: match.range.line + 1,
              startColumn: match.range.startCol + 1,
              endLineNumber: match.range.line + 1,
              endColumn: match.range.endCol + 1,
            },
          },
        );
      }
    },
    [results, rootPath, workspaceId],
  );

  const { onKeyDown: treeOnKeyDown, getRowProps } = useTreeKeyboard({
    rows: keyboardRows,
    focusedIndex,
    onMove: handleMove,
    onToggle: handleToggle,
    onActivate: handleActivate,
  });

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10,
  });

  // Expose first-row focus to parent (for SearchInput ↓ handoff).
  if (firstRowFocusRef) {
    firstRowFocusRef.current = () => {
      if (flatRows.length === 0) return;
      setFocusedIndex(0);
      rowRefs.current.get(0)?.focus();
    };
  }

  function handleMatchClick(group: FileGroup, matchIdx: number) {
    const relP = group.relPath;
    const match = group.matches[matchIdx];
    if (!match) return;

    const absPath = rootPath.endsWith("/") ? `${rootPath}${relP}` : `${rootPath}/${relP}`;

    // revealEditorAt opens (or reveals) the tab and forwards the selection
    // to the reveal-target registry as a single atomic call — the open and
    // selection sides used to be two separate calls at every nav surface,
    // which leaked the "queue may flush after mount" contract into every
    // call site. See `services/editor/tabs/reveal-editor-at.ts` for the
    // contract details.
    revealEditorAt(
      { workspaceId, filePath: absPath },
      {
        selection: {
          startLineNumber: match.range.line + 1,
          startColumn: match.range.startCol + 1,
          endLineNumber: match.range.line + 1,
          endColumn: match.range.endCol + 1,
        },
      },
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-auto app-scrollbar"
      {...(isTree
        ? {
            role: "tree",
            "aria-label": "Search results",
            onKeyDown: (e) => treeOnKeyDown(e.nativeEvent),
          }
        : {})}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = flatRows[vi.index];
          if (!row) return null;

          const wrapperStyle: React.CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: ROW_HEIGHT_PX,
            transform: `translateY(${vi.start}px)`,
          };

          // ── Dir row (tree mode only) ──────────────────────────────────────
          if (row.kind === "dir") {
            const { node, matchCount } = row;
            const isExpanded = expandedDirs.has(node.relPath);
            const rowProps = isTree ? getRowProps(vi.index) : {};
            const depthPad = (node.depth - 1) * 12;
            const Chevron = isExpanded ? ChevronDown : ChevronRight;

            return (
              <div key={`dir-${node.relPath}`} style={wrapperStyle}>
                <button
                  type="button"
                  ref={(el) => {
                    if (el) rowRefs.current.set(vi.index, el);
                    else rowRefs.current.delete(vi.index);
                  }}
                  {...rowProps}
                  aria-expanded={isExpanded}
                  style={{ height: ROW_HEIGHT_PX, paddingLeft: depthPad + 8 }}
                  className="flex items-center w-full pr-2 gap-1 text-left cursor-pointer select-none hover:bg-[var(--state-hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                  onClick={() => onToggleDir?.(node.relPath)}
                >
                  <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <Folder
                    className="size-3.5 shrink-0 text-muted-foreground"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <span className="truncate min-w-0 text-app-body flex-1">{node.displayName}</span>
                  <span className="shrink-0 text-app-ui-sm text-muted-foreground bg-muted rounded px-1">
                    {matchCount}
                  </span>
                </button>
              </div>
            );
          }

          // ── File row ──────────────────────────────────────────────────────
          if (row.kind === "file") {
            const depthPad = isTree ? (row.group.relPath.split("/").length - 1) * 12 : 0;
            const rowProps = isTree ? getRowProps(vi.index) : {};

            return (
              <div key={`file-${row.group.relPath}`} style={wrapperStyle}>
                <div
                  ref={(el) => {
                    if (el) rowRefs.current.set(vi.index, el as HTMLElement);
                    else rowRefs.current.delete(vi.index);
                  }}
                  {...(isTree ? { ...rowProps, style: { paddingLeft: depthPad } } : {})}
                >
                  <SearchResultFileRow
                    relPath={row.group.relPath}
                    matchCount={row.group.matches.length}
                    expanded={row.group.expanded}
                    onToggle={() => onToggleGroup(row.group.relPath)}
                  />
                </div>
              </div>
            );
          }

          // ── Match row ─────────────────────────────────────────────────────
          const match = row.group.matches[row.matchIdx];
          if (!match) return null;

          const rowProps = isTree ? getRowProps(vi.index) : {};

          return (
            <div key={`match-${row.group.relPath}-${row.matchIdx}`} style={wrapperStyle}>
              <div
                ref={(el) => {
                  if (el) rowRefs.current.set(vi.index, el as HTMLElement);
                  else rowRefs.current.delete(vi.index);
                }}
                {...(isTree ? rowProps : {})}
              >
                <SearchResultMatchRow
                  range={match.range}
                  preview={match.preview}
                  onClick={() => handleMatchClick(row.group, row.matchIdx)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

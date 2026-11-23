import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SearchRange } from "../../../../shared/search/types";
import type { FileGroup } from "../../../state/stores/search";
import type { PathTreeNode } from "../../../utils/path-tree";
import { buildPathTree } from "../../../utils/path-tree";
import { ROW_HEIGHT_PX } from "../file-tree/metrics";
import type { TreeKeyboardRow } from "../file-tree/use-tree-keyboard";
import { useTreeKeyboard } from "../file-tree/use-tree-keyboard";
import { SearchResultFileRow } from "./result-file-row";
import { SearchResultMatchRow } from "./result-match-row";

const EMPTY_EXPANDED_DIRS: ReadonlySet<string> = new Set<string>();

type FlatRow =
  | { kind: "file"; group: FileGroup }
  | { kind: "match"; group: FileGroup; matchIdx: number }
  | { kind: "dir"; node: PathTreeNode; matchCount: number };

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

function walkTreeRows(
  node: PathTreeNode,
  expandedDirs: ReadonlySet<string>,
  matchCountMap: Map<string, number>,
  rows: FlatRow[],
  groupByPath: Map<string, FileGroup>,
): void {
  for (const child of node.children ?? []) {
    if (child.kind === "dir") {
      const mc = matchCountMap.get(child.relPath) ?? 0;
      rows.push({ kind: "dir", node: child, matchCount: mc });
      if (expandedDirs.has(child.relPath)) {
        walkTreeRows(child, expandedDirs, matchCountMap, rows, groupByPath);
      }
    } else {
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

function buildTreeRows(results: FileGroup[], expandedDirs: ReadonlySet<string>): FlatRow[] {
  if (results.length === 0) return [];

  const relPaths = results.map((g) => g.relPath);
  const tree = buildPathTree(relPaths);

  const groupByPath = new Map<string, FileGroup>(results.map((g) => [g.relPath, g]));

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
  walkTreeRows(tree, expandedDirs, dirMatchCountMap, rows, groupByPath);
  return rows;
}

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
  return {
    kind: "match",
    relPath: `${row.group.relPath}:${row.matchIdx}`,
    parentRelPath: row.group.relPath,
  };
}

interface SearchResultsListProps {
  onOpenMatch: (relPath: string, range: SearchRange) => void;
  results: FileGroup[];
  onToggleGroup: (relPath: string) => void;
  viewMode?: "list" | "tree";
  expandedDirs?: ReadonlySet<string>;
  onToggleDir?: (relPath: string) => void;
  firstRowFocusRef?: React.MutableRefObject<(() => void) | null>;
}

export function SearchResultsList({
  onOpenMatch,
  results,
  onToggleGroup,
  viewMode = "list",
  expandedDirs = EMPTY_EXPANDED_DIRS,
  onToggleDir,
  firstRowFocusRef,
}: SearchResultsListProps) {
  const { t } = useTranslation("files");
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<number, HTMLElement>>(new Map());
  const [focusedIndex, setFocusedIndex] = useState(0);

  const isTree = viewMode === "tree";

  const flatRows = useMemo<FlatRow[]>(() => {
    if (!isTree) return buildListRows(results);
    return buildTreeRows(results, expandedDirs);
  }, [results, isTree, expandedDirs]);

  const keyboardRows = useMemo<TreeKeyboardRow[]>(
    () => flatRows.map((r) => toKeyboardRow(r, expandedDirs)),
    [flatRows, expandedDirs],
  );

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10,
  });

  const focusRow = useCallback((index: number): boolean => {
    const el = rowRefs.current.get(index);
    if (!el) return false;
    const focusable =
      el.hasAttribute("tabindex") || el instanceof HTMLButtonElement
        ? el
        : el.querySelector<HTMLElement>("button, [tabindex]");
    (focusable ?? el).focus();
    return true;
  }, []);

  const pendingFocusRef = useRef<number | null>(null);
  const handleMove = useCallback(
    (next: number) => {
      setFocusedIndex(next);
      if (focusRow(next)) return;
      pendingFocusRef.current = next;
      virtualizer.scrollToIndex(next);
    },
    [focusRow, virtualizer],
  );
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending !== null && focusRow(pending)) pendingFocusRef.current = null;
  });

  const handleToggle = useCallback(
    (relPath: string, _expanded: boolean) => {
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
        const colonIdx = row.relPath.lastIndexOf(":");
        if (colonIdx === -1) return;
        const filePath = row.relPath.slice(0, colonIdx);
        const idx = parseInt(row.relPath.slice(colonIdx + 1), 10);
        const group = results.find((g) => g.relPath === filePath);
        if (!group) return;
        const match = group.matches[idx];
        if (!match) return;
        onOpenMatch(filePath, match.range);
      }
    },
    [results, onOpenMatch],
  );

  const { onKeyDown: treeOnKeyDown, getRowProps } = useTreeKeyboard({
    rows: keyboardRows,
    focusedIndex,
    onMove: handleMove,
    onToggle: handleToggle,
    onActivate: handleActivate,
  });

  if (firstRowFocusRef) {
    firstRowFocusRef.current = () => {
      if (flatRows.length === 0) return;
      handleMove(0);
    };
  }

  function handleMatchClick(group: FileGroup, matchIdx: number) {
    const match = group.matches[matchIdx];
    if (match) onOpenMatch(group.relPath, match.range);
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-auto app-scrollbar"
      {...(isTree
        ? {
            role: "tree",
            "aria-label": t("search.results.ariaLabel"),
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
                  previewStart={match.previewStart}
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

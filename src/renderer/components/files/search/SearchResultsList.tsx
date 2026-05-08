/**
 * Virtualized flat list of search results.
 *
 * Builds a flat row array from FileGroup[] + expanded state, then uses
 * @tanstack/react-virtual with fixed ROW_HEIGHT_PX row height — same
 * pattern as file-tree-virtual-body.tsx.
 *
 * Row types:
 *   { kind: "file",  group }          — file group header
 *   { kind: "match", group, matchIdx} — single match within a group
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { requestEditorReveal } from "@/services/editor/tabs";
import { useTabsStore } from "@/state/stores/tabs";
import type { FileGroup } from "../../../state/stores/search";
import { ROW_HEIGHT_PX } from "../file-tree/file-tree-metrics";
import { SearchResultFileRow } from "./SearchResultFileRow";
import { SearchResultMatchRow } from "./SearchResultMatchRow";

type FlatRow =
  | { kind: "file"; group: FileGroup }
  | { kind: "match"; group: FileGroup; matchIdx: number };

function buildFlatRows(results: FileGroup[]): FlatRow[] {
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

interface SearchResultsListProps {
  workspaceId: string;
  rootPath: string;
  results: FileGroup[];
  onToggleGroup: (relPath: string) => void;
}

export function SearchResultsList({
  workspaceId,
  rootPath,
  results,
  onToggleGroup,
}: SearchResultsListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const flatRows = buildFlatRows(results);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10,
  });

  function handleMatchClick(group: FileGroup, matchIdx: number) {
    const relP = group.relPath;
    const match = group.matches[matchIdx];
    if (!match) return;

    const absPath = rootPath.endsWith("/") ? `${rootPath}${relP}` : `${rootPath}/${relP}`;

    const tab = useTabsStore.getState().createTab(
      workspaceId,
      {
        type: "editor",
        props: { workspaceId, filePath: absPath },
      },
      /* isPreview */ true,
    );

    // Request a reveal at the match line/col. requestEditorReveal queues the
    // position which the editor picks up on mount or when already open.
    requestEditorReveal({
      workspaceId,
      filePath: absPath,
      range: {
        startLineNumber: match.range.line + 1,
        startColumn: match.range.startCol + 1,
        endLineNumber: match.range.line + 1,
        endColumn: match.range.endCol + 1,
      },
    });

    void tab;
  }

  return (
    <div ref={containerRef} className="flex-1 min-h-0 overflow-auto app-scrollbar">
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

          if (row.kind === "file") {
            return (
              <div key={`file-${row.group.relPath}`} style={wrapperStyle}>
                <SearchResultFileRow
                  relPath={row.group.relPath}
                  matchCount={row.group.matches.length}
                  expanded={row.group.expanded}
                  onToggle={() => onToggleGroup(row.group.relPath)}
                />
              </div>
            );
          }

          const match = row.group.matches[row.matchIdx];
          if (!match) return null;

          return (
            <div key={`match-${row.group.relPath}-${row.matchIdx}`} style={wrapperStyle}>
              <SearchResultMatchRow
                range={match.range}
                preview={match.preview}
                onClick={() => handleMatchClick(row.group, row.matchIdx)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

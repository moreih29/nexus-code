/**
 * Virtualized row body for the file tree.
 *
 * Owns nothing — every interactive callback is forwarded from the
 * parent. Extracted so `file-tree.tsx` can stay focused on store
 * subscriptions, ensure-root effects, and the right-click menu wiring;
 * everything below this component is pure rendering of the precomputed
 * `displayFlat` against the virtualizer's window.
 */

import type { Virtualizer } from "@tanstack/react-virtual";
import type { FlatItem, WorkspaceTree } from "../../state/stores/files";
import type { DisplayItem } from "./file-tree-display";
import { FileTreeEditRow } from "./file-tree-edit-row";
import { ROW_HEIGHT_PX } from "./file-tree-metrics";
import { FileTreeRow } from "./file-tree-row";

interface FileTreeVirtualBodyProps {
  workspaceId: string;
  tree: WorkspaceTree | undefined;
  displayFlat: DisplayItem[];
  flat: FlatItem[];
  activeAbsPath: string | undefined;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  onRowClick: (idx: number, item: FlatItem, e?: React.MouseEvent) => void;
  onRowDoubleClick: (idx: number, item: FlatItem) => void;
  onRowContextMenu: (idx: number, item: FlatItem) => void;
  onPendingCommit: (name: string) => Promise<void> | void;
  onPendingCancel: () => void;
}

export function FileTreeVirtualBody({
  workspaceId,
  tree,
  displayFlat,
  flat,
  activeAbsPath,
  virtualizer,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  onPendingCommit,
  onPendingCancel,
}: FileTreeVirtualBodyProps): React.JSX.Element {
  return (
    <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const item = displayFlat[vi.index];
        if (!item) return null;
        const wrapperStyle: React.CSSProperties = {
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: ROW_HEIGHT_PX,
          transform: `translateY(${vi.start}px)`,
        };

        if (item.kind === "pending") {
          return (
            <div key={`pending-${item.parentAbsPath}`} style={wrapperStyle}>
              <FileTreeEditRow
                kind={item.entryKind}
                depth={item.depth}
                onCommit={onPendingCommit}
                onCancel={onPendingCancel}
              />
            </div>
          );
        }

        const isExpanded = tree?.expanded.has(item.absPath) ?? false;
        const flatIdx = flat.findIndex((f) => f.absPath === item.absPath);
        return (
          <div key={item.absPath} style={wrapperStyle}>
            <FileTreeRow
              workspaceId={workspaceId}
              absPath={item.absPath}
              node={item.node}
              depth={item.depth}
              isExpanded={isExpanded}
              isSelected={item.absPath === activeAbsPath}
              isLoading={tree?.loading.has(item.absPath) ?? false}
              onToggle={() => onRowClick(flatIdx, item)}
              onClick={(e) => onRowClick(flatIdx, item, e)}
              onDoubleClick={() => onRowDoubleClick(flatIdx, item)}
              onContextMenu={() => onRowContextMenu(flatIdx, item)}
            />
          </div>
        );
      })}
    </div>
  );
}

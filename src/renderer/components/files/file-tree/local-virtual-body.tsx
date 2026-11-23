import type { Virtualizer } from "@tanstack/react-virtual";
import { useMemo } from "react";
import { isDrivePath } from "../../../../shared/fs/drive-path";
import type { FlatItem, WorkspaceTree } from "../../../state/stores/files";
import type { DisplayItem } from "./display";
import { DraggableFileTreeRow } from "./draggable-row";
import { FileTreeEditRow } from "./edit-row";
import type { GitDecorationKind } from "./git-decoration";
import { FileTreeVirtualBody } from "./virtual-body";

export interface FileTreeDecorationLookup {
  decoration: (absPath: string, isDir: boolean) => GitDecorationKind | undefined;
  isIgnored: (absPath: string, isDir: boolean) => boolean;
}

interface FileTreeVirtualBodyProps {
  workspaceId: string;
  tree: WorkspaceTree | undefined;
  displayFlat: DisplayItem[];
  flat: FlatItem[];
  activeAbsPath: string | undefined;
  isPathSelected: (absPath: string) => boolean;
  isPathCut: (absPath: string) => boolean;
  encodeRowId: (absPath: string) => string;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  decorationLookup: FileTreeDecorationLookup;
  onRowClick: (idx: number, item: FlatItem, e?: React.MouseEvent) => void;
  onRowDoubleClick: (idx: number, item: FlatItem) => void;
  onRowContextMenu: (idx: number, item: FlatItem) => void;
  onPendingCommit: (name: string) => Promise<void> | void;
  onPendingCancel: () => void;
  onPendingRenameCommit: (name: string) => Promise<void> | void;
  onPendingRenameCancel: () => void;
}

export function LocalFileTreeVirtualBody({
  workspaceId,
  tree,
  displayFlat,
  flat,
  activeAbsPath,
  isPathSelected,
  isPathCut,
  encodeRowId,
  virtualizer,
  decorationLookup,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  onPendingCommit,
  onPendingCancel,
  onPendingRenameCommit,
  onPendingRenameCancel,
}: FileTreeVirtualBodyProps): React.JSX.Element {
  const flatIndexByPath = useMemo(() => {
    return new Map(flat.map((f, i) => [f.absPath, i]));
  }, [flat]);

  return (
    <FileTreeVirtualBody
      virtualizer={virtualizer}
      rowKey={(index) => {
        const item = displayFlat[index];
        if (!item) return undefined;
        return item.kind === "pending"
          ? `pending-${item.parentAbsPath}`
          : `${item.kind}-${item.absPath}`;
      }}
      renderRow={(index) => {
        const item = displayFlat[index];
        if (!item) return null;
        if (item.kind === "pending") {
          return (
            <div style={{ position: "relative", zIndex: 1 }} data-file-tree-row-type="pending">
              <FileTreeEditRow
                kind={item.entryKind}
                depth={item.depth}
                windows={isDrivePath(item.parentAbsPath)}
                onCommit={onPendingCommit}
                onCancel={onPendingCancel}
              />
            </div>
          );
        }

        if (item.kind === "rename") {
          return (
            <div style={{ position: "relative", zIndex: 1 }} data-file-tree-row-type="rename">
              <FileTreeEditRow
                kind={item.entryKind}
                depth={item.depth}
                initialValue={item.initialName}
                windows={isDrivePath(item.absPath)}
                onCommit={onPendingRenameCommit}
                onCancel={onPendingRenameCancel}
              />
            </div>
          );
        }

        const isExpanded = tree?.expanded.has(item.absPath) ?? false;
        const flatIdx = flatIndexByPath.get(item.absPath) ?? -1;
        const isDir = item.node.type === "dir";
        const decoration = decorationLookup.decoration(item.absPath, isDir);
        const isIgnored = decorationLookup.isIgnored(item.absPath, isDir);
        return (
          <div data-file-tree-row-type={item.node.type} data-file-tree-row-path={item.absPath}>
            <DraggableFileTreeRow
              id={encodeRowId(item.absPath)}
              workspaceId={workspaceId}
              absPath={item.absPath}
              node={item.node}
              depth={item.depth}
              isExpanded={isExpanded}
              isSelected={isPathSelected(item.absPath)}
              isFocused={item.absPath === activeAbsPath}
              isCut={isPathCut(item.absPath)}
              isRoot={item.absPath === tree?.rootAbsPath}
              isLoading={tree?.loading.has(item.absPath) ?? false}
              decoration={decoration}
              isIgnored={isIgnored}
              onClick={(e) => onRowClick(flatIdx, item, e)}
              onDoubleClick={() => onRowDoubleClick(flatIdx, item)}
              onContextMenu={() => onRowContextMenu(flatIdx, item)}
            />
          </div>
        );
      }}
    />
  );
}

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
import type { FlatItem, WorkspaceTree } from "../../../state/stores/files";
import type { DisplayItem } from "./display";
import { FileTreeEditRow } from "./edit-row";
import type { GitDecorationKind } from "./git-decoration";
import { ROW_HEIGHT_PX } from "./metrics";
import { FileTreeRow } from "./row";

/**
 * Lookups passed from the parent so the body stays a pure renderer. The
 * file-tree owns the git store subscription + ignored-cache enqueuing and
 * exposes the per-row answers as two synchronous functions; this body
 * forwards them to each row without re-reading the stores itself.
 */
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

export function FileTreeVirtualBody({
  workspaceId,
  tree,
  displayFlat,
  flat,
  activeAbsPath,
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
            <div
              key={`pending-${item.parentAbsPath}`}
              style={wrapperStyle}
              data-file-tree-row-type="pending"
            >
              <FileTreeEditRow
                kind={item.entryKind}
                depth={item.depth}
                onCommit={onPendingCommit}
                onCancel={onPendingCancel}
              />
            </div>
          );
        }

        if (item.kind === "rename") {
          return (
            <div
              key={`rename-${item.absPath}`}
              style={wrapperStyle}
              data-file-tree-row-type="rename"
            >
              <FileTreeEditRow
                kind={item.entryKind}
                depth={item.depth}
                initialValue={item.initialName}
                onCommit={onPendingRenameCommit}
                onCancel={onPendingRenameCancel}
              />
            </div>
          );
        }

        const isExpanded = tree?.expanded.has(item.absPath) ?? false;
        const flatIdx = flat.findIndex((f) => f.absPath === item.absPath);
        const isDir = item.node.type === "dir";
        const decoration = decorationLookup.decoration(item.absPath, isDir);
        const isIgnored = !isDir && decorationLookup.isIgnored(item.absPath, isDir);
        return (
          <div
            key={item.absPath}
            style={wrapperStyle}
            data-file-tree-row-type={item.node.type}
            data-file-tree-row-path={item.absPath}
          >
            <FileTreeRow
              workspaceId={workspaceId}
              absPath={item.absPath}
              node={item.node}
              depth={item.depth}
              isExpanded={isExpanded}
              isSelected={item.absPath === activeAbsPath}
              isLoading={tree?.loading.has(item.absPath) ?? false}
              decoration={decoration}
              isIgnored={isIgnored}
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

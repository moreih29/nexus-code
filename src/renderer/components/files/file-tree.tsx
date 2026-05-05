"use no memo";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { openOrRevealEditor } from "../../services/editor";
import { selectFlat, useFilesStore } from "../../state/stores/files";
import { getDisplayFlat } from "./file-tree-display";
import { FileTreeEditRow } from "./file-tree-edit-row";
import { buildFileTreeMenuItems } from "./file-tree-menu";
import { FileTreeRow } from "./file-tree-row";
import { FileTreeStatusView } from "./file-tree-status-view";
import { createFileTreeKeydownHandler } from "./keys";
import { type FileTreeActionTarget, useFileTreeActions } from "./use-file-tree-actions";
import { useFileTreePendingCreate } from "./use-file-tree-pending-create";

interface FileTreeProps {
  workspaceId: string;
  rootAbsPath: string;
}

export function FileTree({ workspaceId, rootAbsPath }: FileTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Subscribe to the workspace's tree slice; recompute the flat list only when
  // that slice's reference changes. selectFlat always returns a fresh array of
  // fresh wrapper objects, so any selector with reference comparison (Object.is
  // or shallow element-wise) would forceStoreRerender on every store tick and
  // trigger "Maximum update depth exceeded". Using `tree` as the useMemo dep
  // keeps the flat array stable between unrelated store updates.
  const tree = useFilesStore((s) => s.trees.get(workspaceId));
  const flat = useMemo(() => {
    if (!tree) return [];
    return selectFlat(useFilesStore.getState(), workspaceId);
  }, [tree, workspaceId]);

  // ensureRoot on mount/workspaceId change
  useEffect(() => {
    useFilesStore.getState().ensureRoot(workspaceId, rootAbsPath);
  }, [workspaceId, rootAbsPath]);

  // 200ms loading delay state
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    const isLoading = tree?.loading.has(rootAbsPath) ?? false;
    if (!isLoading) {
      setShowLoading(false);
      return;
    }
    const t = setTimeout(() => setShowLoading(true), 200);
    return () => clearTimeout(t);
  }, [tree, rootAbsPath]);

  const [activeIndex, setActiveIndex] = useState(0);
  // Anchor for the right-click menu — set in the row's onContextMenu (bubble
  // phase) so it lands in state before Radix's Trigger opens the menu.
  const [contextTarget, setContextTarget] = useState<FileTreeActionTarget | null>(null);

  const pendingCreate = useFileTreePendingCreate({ workspaceId, rootAbsPath });

  // Holds a New-File/New-Folder request raised from a menu item until the
  // surrounding ContextMenu has fully closed. Mounting the inline-edit
  // row earlier (synchronously inside onSelect) doesn't work: while
  // Radix's <FocusScope> is still active during the close animation, any
  // focus() call from the freshly-mounted input is intercepted and pulled
  // back into the menu. Replaying the request from onCloseAutoFocus —
  // which fires after FocusScope releases — lets the input's autoFocus
  // claim the caret cleanly. The ref also serves as the "should we
  // suppress the trigger refocus?" signal, so generic menu items
  // (Reveal, Copy Path) keep their default focus-return behavior.
  const pendingCreateRequestRef = useRef<{
    parentAbsPath: string;
    kind: "file" | "folder";
  } | null>(null);

  const fileTreeActions = useFileTreeActions({
    workspaceId,
    rootAbsPath,
    getTarget: () => contextTarget,
    startCreate: (parentAbsPath, kind) => {
      pendingCreateRequestRef.current = { parentAbsPath, kind };
    },
  });

  // Inject the pending-create sentinel row into the flat list at the
  // right child position. Recomputed on every render — cheap pure
  // function over an already-cheap flat array.
  const displayFlat = useMemo(
    () => getDisplayFlat(flat, pendingCreate.pending),
    [flat, pendingCreate.pending],
  );

  const virtualizer = useVirtualizer({
    count: displayFlat.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 24,
    overscan: 10,
  });

  // Empty / loading / error pose. Returns null for "pre-200ms hidden" so
  // the caller mirrors the same condition.
  if (flat.length === 0) {
    return (
      <FileTreeStatusView
        workspaceId={workspaceId}
        rootAbsPath={rootAbsPath}
        rootError={tree?.errors.get(rootAbsPath)}
        isLoading={tree?.loading.has(rootAbsPath) ?? false}
        showLoading={showLoading}
        treeKnown={!!tree}
      />
    );
  }

  const handleKeyDown = createFileTreeKeydownHandler({
    flat,
    tree,
    workspaceId,
    rootAbsPath,
    activeIndex,
    setActiveIndex,
    scrollToIndex: (i) => virtualizer.scrollToIndex(i),
  });

  function handleRowClick(idx: number, item: (typeof flat)[number], e?: React.MouseEvent) {
    setActiveIndex(idx);
    if (item.node.type === "dir") {
      useFilesStore.getState().toggleExpand(workspaceId, item.absPath);
    } else if (e && (e.metaKey || e.ctrlKey)) {
      openOrRevealEditor(
        { workspaceId, filePath: item.absPath },
        { newSplit: { orientation: "horizontal", side: "after", isPreview: true } },
      );
    } else {
      openOrRevealEditor({ workspaceId, filePath: item.absPath });
    }
  }

  function handleRowDoubleClick(idx: number, item: (typeof flat)[number]) {
    if (item.node.type !== "file") return;
    setActiveIndex(idx);
    // VSCode parity: double-click in the explorer opens the file as a
    // permanent tab (no preview slot, no italic title). Goes through
    // openOrRevealEditor so existing-tab reveal still applies.
    openOrRevealEditor({ workspaceId, filePath: item.absPath }, { preview: false });
  }

  const activeAbsPath = flat[activeIndex]?.absPath;

  // Empty-area right-click → synthesise a root target so the menu still
  // shows New File / New Folder etc. anchored at the workspace root.
  // Row's own onContextMenu fires first (deepest first in the bubble);
  // we only step in when no row sits between the target and us.
  function handleAreaContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (!t.closest('button[role="treeitem"]')) {
      setContextTarget({ absPath: rootAbsPath, type: "dir", isRoot: true });
    }
  }

  return (
    <ContextMenuRoot onOpenChange={(open) => !open && setContextTarget(null)}>
      <ContextMenuTrigger>
        <div
          ref={containerRef}
          role="tree"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onContextMenu={handleAreaContextMenu}
          className="h-full overflow-auto focus:outline-none"
        >
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const item = displayFlat[vi.index];
              if (!item) return null;
              const wrapperStyle: React.CSSProperties = {
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: 24,
                transform: `translateY(${vi.start}px)`,
              };

              if (item.kind === "pending") {
                return (
                  <div key={`pending-${item.parentAbsPath}`} style={wrapperStyle}>
                    <FileTreeEditRow
                      kind={item.entryKind}
                      depth={item.depth}
                      onCommit={async (name) => {
                        await pendingCreate.commit(name);
                      }}
                      onCancel={pendingCreate.cancel}
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
                    onToggle={() => handleRowClick(flatIdx, item)}
                    onClick={(e) => handleRowClick(flatIdx, item, e)}
                    onDoubleClick={() => handleRowDoubleClick(flatIdx, item)}
                    onContextMenu={() => {
                      if (flatIdx >= 0) setActiveIndex(flatIdx);
                      setContextTarget({ absPath: item.absPath, type: item.node.type });
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          // If a New-File/New-Folder request was queued by an onSelect,
          // replay it now that Radix's FocusScope has released. Suppress
          // the default "focus the trigger" so the inline-edit row's
          // autoFocus can take the caret cleanly on the next render.
          const req = pendingCreateRequestRef.current;
          if (req) {
            e.preventDefault();
            pendingCreateRequestRef.current = null;
            pendingCreate.startCreate(req.parentAbsPath, req.kind);
          }
        }}
      >
        <ContextMenuItems items={buildFileTreeMenuItems(contextTarget, fileTreeActions)} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

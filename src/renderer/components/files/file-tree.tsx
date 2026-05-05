"use no memo";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useContextMenuHandoff } from "@/components/ui/use-context-menu-handoff";
import { openOrRevealEditor } from "../../services/editor";
import { selectFlat, useFilesStore } from "../../state/stores/files";
import { getDisplayFlat } from "./file-tree-display";
import { buildFileTreeMenuItems } from "./file-tree-menu";
import { LOADING_FLASH_DELAY_MS, ROW_HEIGHT_PX } from "./file-tree-metrics";
import { FileTreeStatusView } from "./file-tree-status-view";
import { FileTreeVirtualBody } from "./file-tree-virtual-body";
import { useDelayedLoading } from "./use-delayed-loading";
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

  const isLoading = tree?.loading.has(rootAbsPath) ?? false;
  const showLoading = useDelayedLoading(isLoading, LOADING_FLASH_DELAY_MS);

  const [activeIndex, setActiveIndexLocal] = useState(0);
  // Mirror the active row's absPath into the files store so global
  // handlers (e.g. the `openToSide` keybinding) can act on it without
  // having access to the tree's component-local state. We funnel every
  // setActiveIndex callsite through this wrapper so the two stay in
  // sync; missing rows (e.g. while the flat list is rebuilding) become
  // null in the store.
  const setActiveIndex = (next: number) => {
    setActiveIndexLocal(next);
    const path = flat[next]?.absPath ?? null;
    useFilesStore.getState().setActiveAbsPath(workspaceId, path);
  };
  useEffect(() => {
    const path = flat[activeIndex]?.absPath ?? null;
    useFilesStore.getState().setActiveAbsPath(workspaceId, path);
  }, [flat, activeIndex, workspaceId]);
  // Anchor for the right-click menu — set in the row's onContextMenu (bubble
  // phase) so it lands in state before Radix's Trigger opens the menu.
  const [contextTarget, setContextTarget] = useState<FileTreeActionTarget | null>(null);

  const pendingCreate = useFileTreePendingCreate({ workspaceId, rootAbsPath });

  // New-File / New-Folder need their inline-edit row mounted *after* the
  // ContextMenu's FocusScope releases — see useContextMenuHandoff for
  // the reasoning. Generic items (Reveal, Copy Path) skip the handoff
  // entirely, so Radix's default trigger refocus still runs for them.
  const menuHandoff = useContextMenuHandoff();

  const fileTreeActions = useFileTreeActions({
    workspaceId,
    rootAbsPath,
    getTarget: () => contextTarget,
    startCreate: (parentAbsPath, kind) => {
      menuHandoff.defer(() => pendingCreate.startCreate(parentAbsPath, kind));
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
    estimateSize: () => ROW_HEIGHT_PX,
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
        isLoading={isLoading}
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
          className="h-full overflow-auto app-scrollbar focus:outline-none"
        >
          <FileTreeVirtualBody
            workspaceId={workspaceId}
            tree={tree}
            displayFlat={displayFlat}
            flat={flat}
            activeAbsPath={activeAbsPath}
            virtualizer={virtualizer}
            onRowClick={handleRowClick}
            onRowDoubleClick={handleRowDoubleClick}
            onRowContextMenu={(flatIdx, item) => {
              if (flatIdx >= 0) setActiveIndex(flatIdx);
              setContextTarget({ absPath: item.absPath, type: item.node.type });
            }}
            onPendingCommit={async (name) => {
              await pendingCreate.commit(name);
            }}
            onPendingCancel={pendingCreate.cancel}
          />
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent onCloseAutoFocus={menuHandoff.onCloseAutoFocus}>
        <ContextMenuItems items={buildFileTreeMenuItems(contextTarget, fileTreeActions)} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

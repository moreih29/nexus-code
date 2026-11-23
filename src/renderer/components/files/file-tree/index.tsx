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
import { findLeaf } from "@/engine";
import { useDelayedLoading } from "../../../hooks/use-delayed-loading";
import { openOrRevealEditor } from "../../../services/editor";
import { useFileClipboardStore } from "../../../services/file-clipboard";
import { requestTabFocus } from "../../../services/tab-focus";
import {
  collapseAll,
  ensureRoot,
  refresh,
  reveal,
  revealEditorActiveFile,
  toggleExpand,
} from "../../../state/operations/files";
import { parentOf, selectFlat, selectIsSelected, useFilesStore } from "../../../state/stores/files";
import { joinPath } from "../../../state/stores/files/helpers";
import { useGitSession, useGitStore } from "../../../state/stores/git";
import { selectGitDecorations } from "../../../state/stores/git/decorations";
import { useIgnoredStore } from "../../../state/stores/git/ignored";
import { useLayoutStore } from "../../../state/stores/layout";
import { useTabsStore } from "../../../state/stores/tabs";
import { relativeTo } from "../../../utils/path";
import { type FileTreeActionTarget, useFileTreeActions } from "../hooks/use-file-tree-actions";
import { useFileTreeDropTarget } from "../hooks/use-file-tree-drop-target";
import { useFileTreePendingCreate } from "../hooks/use-file-tree-pending-create";
import { useFileTreePendingRename } from "../hooks/use-file-tree-pending-rename";
import { createFileTreeKeydownHandler } from "../keys";
import { getDisplayFlat } from "./display";
import { type FileTreeDecorationLookup, LocalFileTreeVirtualBody } from "./local-virtual-body";
import { buildFileTreeMenuItems } from "./menu";
import { LOADING_FLASH_DELAY_MS, ROW_HEIGHT_PX } from "./metrics";
import { WorkspaceRootHeader } from "./root-header";
import { FileTreeStatusView } from "./status-view";

interface FileTreeProps {
  workspaceId: string;
  rootAbsPath: string;
}

export function FileTree({ workspaceId, rootAbsPath }: FileTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tree = useFilesStore((s) => s.trees.get(workspaceId));
  const flat = useMemo(() => {
    if (!tree) return [];
    return selectFlat(useFilesStore.getState(), workspaceId).slice(1);
  }, [tree, workspaceId]);
  const rootExpanded = tree ? tree.expanded.has(rootAbsPath) : true;

  useEffect(() => {
    ensureRoot(workspaceId, rootAbsPath);
  }, [workspaceId, rootAbsPath]);

  const isLoading = tree?.loading.has(rootAbsPath) ?? false;
  const showLoading = useDelayedLoading(isLoading, LOADING_FLASH_DELAY_MS);

  const selection = useFilesStore((s) => s.selection.get(workspaceId));
  const focusPath = selection?.focus ?? null;
  const activeIndex = useMemo(() => {
    if (!focusPath) return 0;
    const idx = flat.findIndex((f) => f.absPath === focusPath);
    return idx >= 0 ? idx : 0;
  }, [flat, focusPath]);

  const setActiveIndex = (next: number) => {
    const path = flat[next]?.absPath ?? null;
    if (path !== null) {
      useFilesStore.getState().setSingleSelection(workspaceId, path);
    }
  };

  const layoutForWs = useLayoutStore((s) => s.byWorkspace[workspaceId]);
  const tabsForWs = useTabsStore((s) => s.byWorkspace[workspaceId]);
  const activeEditorAbsPath = useMemo<string | null>(() => {
    if (!layoutForWs) return null;
    const leaf = findLeaf(layoutForWs.root, layoutForWs.activeGroupId);
    const tabId = leaf?.activeTabId;
    if (!tabId) return null;
    const tab = tabsForWs?.[tabId];
    if (!tab) return null;
    if (tab.type === "editor") return tab.props.filePath;
    if (tab.type === "editor.diff" && tab.props.relPath) {
      return joinPath(rootAbsPath, tab.props.relPath);
    }
    return null;
  }, [layoutForWs, tabsForWs, rootAbsPath]);

  const gitSession = useGitSession(workspaceId);
  const ignoredVersion = useIgnoredStore((s) => s.byWorkspace.get(workspaceId)?.version ?? 0);
  const repoTopLevel = gitSession?.repoInfo.kind === "repo" ? gitSession.repoInfo.topLevel : null;
  const decorationMaps = useMemo(() => {
    void gitSession;
    return selectGitDecorations(useGitStore.getState(), workspaceId, rootAbsPath);
  }, [gitSession, workspaceId, rootAbsPath]);

  const decorationLookup = useMemo<FileTreeDecorationLookup>(() => {
    const enqueueCheck = useIgnoredStore.getState().enqueueCheck;
    const isIgnoredFn = useIgnoredStore.getState().isIgnored;
    return {
      decoration: (absPath, isDir) =>
        isDir ? decorationMaps.folders.get(absPath) : decorationMaps.files.get(absPath),
      isIgnored: (absPath, isDir) => {
        if (!repoTopLevel) return false;
        if ((isDir ? decorationMaps.folders : decorationMaps.files).has(absPath)) return false;
        const flag = isIgnoredFn(workspaceId, absPath);
        if (flag === undefined) {
          const root = repoTopLevel.replace(/[\\/]+$/, "");
          if (absPath.startsWith(`${root}/`)) {
            const relPath = absPath.slice(root.length + 1);
            enqueueCheck(workspaceId, absPath, relPath);
          }
          return false;
        }
        void ignoredVersion;
        return flag;
      },
    };
  }, [decorationMaps, workspaceId, repoTopLevel, ignoredVersion]);

  const [contextTargets, setContextTargets] = useState<FileTreeActionTarget[]>([]);

  const pendingCreate = useFileTreePendingCreate({ workspaceId, rootAbsPath });
  const pendingRename = useFileTreePendingRename({ workspaceId, rootAbsPath });

  useFileTreeDropTarget({ containerRef, workspaceId, workspaceRootPath: rootAbsPath });

  const menuHandoff = useContextMenuHandoff();

  const fileTreeActions = useFileTreeActions({
    workspaceId,
    rootAbsPath,
    getTargets: () => contextTargets,
    startCreate: (parentAbsPath, kind) => {
      menuHandoff.defer(() => pendingCreate.startCreate(parentAbsPath, kind));
    },
    startRename: (absPath) => {
      menuHandoff.defer(() => pendingRename.startRename(absPath));
    },
  });

  const displayFlat = useMemo(
    () => getDisplayFlat(flat, pendingCreate.pending, pendingRename.pending, rootAbsPath),
    [flat, pendingCreate.pending, pendingRename.pending, rootAbsPath],
  );

  const virtualizer = useVirtualizer({
    count: displayFlat.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10,
  });

  const lastRevealedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeEditorAbsPath) return;
    if (relativeTo(activeEditorAbsPath, rootAbsPath) === activeEditorAbsPath) return;
    if (lastRevealedRef.current === activeEditorAbsPath) return;
    if (flat.some((f) => f.absPath === activeEditorAbsPath)) return;
    void reveal(workspaceId, activeEditorAbsPath);
  }, [activeEditorAbsPath, workspaceId, rootAbsPath, flat]);

  useEffect(() => {
    if (!activeEditorAbsPath) return;
    if (lastRevealedRef.current === activeEditorAbsPath) return;
    const idx = flat.findIndex((f) => f.absPath === activeEditorAbsPath);
    if (idx < 0) return;
    lastRevealedRef.current = activeEditorAbsPath;
    revealEditorActiveFile(workspaceId, activeEditorAbsPath);
    virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [activeEditorAbsPath, flat, virtualizer, workspaceId]);

  const showStatusView = displayFlat.length === 0 && rootExpanded;

  const flatPaths = useMemo(() => flat.map((f) => f.absPath), [flat]);

  const handleKeyDown = createFileTreeKeydownHandler({
    flat,
    flatPaths,
    tree,
    workspaceId,
    rootAbsPath,
    activeIndex,
    setActiveIndex,
    scrollToIndex: (i) => virtualizer.scrollToIndex(i),
    startRename: (absPath) => pendingRename.startRename(absPath),
  });

  function handleRowClick(_idx: number, item: (typeof flat)[number], e?: React.MouseEvent) {
    const store = useFilesStore.getState();

    containerRef.current?.focus({ preventScroll: true });

    if (e?.shiftKey) {
      store.extendSelectionTo(workspaceId, item.absPath, flatPaths);
      return;
    }

    if (e?.metaKey || e?.ctrlKey) {
      store.toggleSelection(workspaceId, item.absPath);
      return;
    }

    store.setSingleSelection(workspaceId, item.absPath);
    if (item.node.type === "dir") {
      toggleExpand(workspaceId, item.absPath);
    } else {
      openOrRevealEditor({ workspaceId, filePath: item.absPath });
    }
  }

  function handleRowDoubleClick(idx: number, item: (typeof flat)[number]) {
    if (item.node.type !== "file") return;
    setActiveIndex(idx);
    const { tabId } = openOrRevealEditor(
      { workspaceId, filePath: item.absPath },
      { preview: false },
    );
    requestTabFocus(tabId);
  }

  const activeAbsPath = focusPath ?? undefined;

  const isPathSelected = (absPath: string): boolean =>
    selectIsSelected(useFilesStore.getState(), workspaceId, absPath);

  const clipKind = useFileClipboardStore((s) => s.kind);
  const clipEntries = useFileClipboardStore((s) => s.entries);
  const cutPathSet = useMemo<ReadonlySet<string>>(() => {
    if (clipKind !== "cut") return new Set();
    return new Set(clipEntries.map((e) => e.absPath));
  }, [clipKind, clipEntries]);
  const isPathCut = (absPath: string): boolean => cutPathSet.has(absPath);

  function encodeRowId(absPath: string): string {
    return `tree-row-${absPath.replace(/[^a-zA-Z0-9]/g, "_")}`;
  }
  const focusRowId = focusPath ? encodeRowId(focusPath) : undefined;

  function handleAreaContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (!t.closest('button[role="treeitem"]')) {
      setContextTargets([{ absPath: rootAbsPath, type: "dir", isRoot: true }]);
    }
  }

  const resolveHeaderCreateParent = (): string => {
    if (!focusPath) return rootAbsPath;
    const node = tree?.nodes.get(focusPath);
    if (!node) return rootAbsPath;
    if (node.type === "dir") return focusPath;
    return parentOf(focusPath, rootAbsPath);
  };
  const handleHeaderToggle = () => {
    void toggleExpand(workspaceId, rootAbsPath);
  };
  const handleHeaderNewFile = () => {
    pendingCreate.startCreate(resolveHeaderCreateParent(), "file");
  };
  const handleHeaderNewFolder = () => {
    pendingCreate.startCreate(resolveHeaderCreateParent(), "folder");
  };
  const handleHeaderRefresh = () => {
    void refresh(workspaceId);
  };
  const handleHeaderCollapseAll = () => {
    void collapseAll(workspaceId);
  };
  const handleHeaderContextMenu = (_e: React.MouseEvent<HTMLDivElement>) => {
    setContextTargets([{ absPath: rootAbsPath, type: "dir", isRoot: true }]);
  };

  return (
    <ContextMenuRoot onOpenChange={(open) => !open && setContextTargets([])}>
      <ContextMenuTrigger>
        <div className="group/filetree flex h-full flex-col">
          <WorkspaceRootHeader
            rootAbsPath={rootAbsPath}
            isExpanded={rootExpanded}
            onToggle={handleHeaderToggle}
            onNewFile={handleHeaderNewFile}
            onNewFolder={handleHeaderNewFolder}
            onRefresh={handleHeaderRefresh}
            onCollapseAll={handleHeaderCollapseAll}
            onContextMenu={handleHeaderContextMenu}
          />
          <div
            ref={containerRef}
            role="tree"
            tabIndex={0}
            aria-multiselectable="true"
            aria-activedescendant={focusRowId}
            onKeyDown={handleKeyDown}
            onContextMenu={handleAreaContextMenu}
            onClick={(e) => {
              const target = e.target as HTMLElement;
              if (target.closest("[data-file-tree-row-type]")) return;
              useFilesStore.getState().clearSelection(workspaceId);
            }}
            className="flex-1 min-h-0 overflow-auto app-scrollbar focus:outline-none"
          >
            {showStatusView ? (
              <FileTreeStatusView
                workspaceId={workspaceId}
                rootAbsPath={rootAbsPath}
                rootError={tree?.errors.get(rootAbsPath)}
                isLoading={isLoading}
                showLoading={showLoading}
                treeKnown={!!tree}
              />
            ) : (
              <LocalFileTreeVirtualBody
                workspaceId={workspaceId}
                tree={tree}
                displayFlat={displayFlat}
                flat={flat}
                activeAbsPath={activeAbsPath}
                isPathSelected={isPathSelected}
                isPathCut={isPathCut}
                encodeRowId={encodeRowId}
                virtualizer={virtualizer}
                decorationLookup={decorationLookup}
                onRowClick={handleRowClick}
                onRowDoubleClick={handleRowDoubleClick}
                onRowContextMenu={(flatIdx, item) => {
                  if (flatIdx >= 0) {
                    const sel = useFilesStore.getState().selection.get(workspaceId);
                    const inSet = sel ? sel.paths.has(item.absPath) : false;
                    if (inSet) {
                      useFilesStore.getState().setFocus(workspaceId, item.absPath);
                    } else {
                      useFilesStore.getState().setSingleSelection(workspaceId, item.absPath);
                    }

                    const selAfter = useFilesStore.getState().selection.get(workspaceId);
                    if (selAfter && selAfter.paths.size > 0 && selAfter.paths.has(item.absPath)) {
                      const targets: FileTreeActionTarget[] = [];
                      for (const p of selAfter.paths) {
                        const node = useFilesStore.getState().trees.get(workspaceId)?.nodes.get(p);
                        if (node) targets.push({ absPath: p, type: node.type });
                      }
                      setContextTargets(targets);
                    } else {
                      setContextTargets([{ absPath: item.absPath, type: item.node.type }]);
                    }
                  }
                }}
                onPendingCommit={async (name) => {
                  await pendingCreate.commit(name);
                }}
                onPendingCancel={pendingCreate.cancel}
                onPendingRenameCommit={async (name) => {
                  await pendingRename.commit(name);
                }}
                onPendingRenameCancel={pendingRename.cancel}
              />
            )}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent onCloseAutoFocus={menuHandoff.onCloseAutoFocus}>
        <ContextMenuItems items={buildFileTreeMenuItems(contextTargets, fileTreeActions)} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

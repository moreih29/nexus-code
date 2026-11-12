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
import { useGitSession, useGitStore } from "../../../state/stores/git";
import { selectGitDecorations } from "../../../state/stores/git/decorations";
import { useIgnoredStore } from "../../../state/stores/git/ignored";
import { useLayoutStore } from "../../../state/stores/layout";
import { useTabsStore } from "../../../state/stores/tabs";
import { type FileTreeActionTarget, useFileTreeActions } from "../hooks/use-file-tree-actions";
import { useFileTreeDropTarget } from "../hooks/use-file-tree-drop-target";
import { useFileTreePendingCreate } from "../hooks/use-file-tree-pending-create";
import { useFileTreePendingRename } from "../hooks/use-file-tree-pending-rename";
import { createFileTreeKeydownHandler } from "../keys";
import { getDisplayFlat } from "./display";
import { buildFileTreeMenuItems } from "./menu";
import { LOADING_FLASH_DELAY_MS, ROW_HEIGHT_PX } from "./metrics";
import { WorkspaceRootHeader } from "./root-header";
import { FileTreeStatusView } from "./status-view";
import { type FileTreeDecorationLookup, FileTreeVirtualBody } from "./virtual-body";

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
  // `flat` excludes the workspace root: the root is rendered separately by
  // <WorkspaceRootHeader> above the virtualized list. selectFlat() always
  // returns the root as `[0]` (depth=0), so slicing it off here gives the
  // children-only view every consumer below (virtualizer, Cmd+A, keyboard
  // nav, click handlers) now operates on.
  //
  // When the root is collapsed, selectFlat returns just [root]; slicing
  // yields [] and the tree shows empty — exactly what the user expects
  // when they collapse the workspace header.
  const flat = useMemo(() => {
    if (!tree) return [];
    return selectFlat(useFilesStore.getState(), workspaceId).slice(1);
  }, [tree, workspaceId]);
  const rootExpanded = tree ? tree.expanded.has(rootAbsPath) : true;

  // ensureRoot on mount/workspaceId change
  useEffect(() => {
    ensureRoot(workspaceId, rootAbsPath);
  }, [workspaceId, rootAbsPath]);

  const isLoading = tree?.loading.has(rootAbsPath) ?? false;
  const showLoading = useDelayedLoading(isLoading, LOADING_FLASH_DELAY_MS);

  // Subscribe to the full per-workspace FileSelection object — not just
  // `focus`. Every selection reducer (singleSelection / toggle / extend /
  // selectAllHierarchical / clearToFocus / setFocus / clearSelection) returns
  // a new FileSelection, so subscribing to the object reference catches
  // updates to focus AND paths AND anchor — `selectAllHierarchical` after
  // a single-select leaves focus untouched but balloons paths; subscribing
  // to focus alone would skip the re-render and rows would render stale
  // selection visuals until something else triggered a render (e.g. clicking
  // away to another tab). Derive focusPath from the captured selection.
  const selection = useFilesStore((s) => s.selection.get(workspaceId));
  const focusPath = selection?.focus ?? null;
  const activeIndex = useMemo(() => {
    if (!focusPath) return 0;
    const idx = flat.findIndex((f) => f.absPath === focusPath);
    return idx >= 0 ? idx : 0;
  }, [flat, focusPath]);

  // Wrapper used by the keyboard handler and row-click paths — keeps the
  // interface identical to the previous setActiveIndex(number) shape so
  // all callsites below are unchanged.
  const setActiveIndex = (next: number) => {
    const path = flat[next]?.absPath ?? null;
    if (path !== null) {
      useFilesStore.getState().setSingleSelection(workspaceId, path);
    }
  };

  // Absolute path of the file the active editor tab points to. Only editor / editor.diff count.
  // It is null while a tab with no file (terminal, git.commit, etc.) is active, and the tree
  // highlight is left alone then (the existing state is kept).
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
      return `${rootAbsPath}/${tab.props.relPath}`;
    }
    return null;
  }, [layoutForWs, tabsForWs, rootAbsPath]);

  // ---------------------------------------------------------------------------
  // Git decorations
  // ---------------------------------------------------------------------------
  // Subscribe to the workspace's git session so any `statusChanged` push
  // re-renders the tree. The actual decoration Maps are built lazily on
  // first access (`selectGitDecorations` memoizes on the session reference).
  // Ignored-flag subscription pulls from the ignored store's version so
  // batch flushes propagate without re-running the heavier decoration
  // selector.
  const gitSession = useGitSession(workspaceId);
  const ignoredVersion = useIgnoredStore((s) => s.byWorkspace.get(workspaceId)?.version ?? 0);
  const repoTopLevel = gitSession?.repoInfo.kind === "repo" ? gitSession.repoInfo.topLevel : null;
  const decorationMaps = useMemo(() => {
    // gitSession dep ensures recompute on statusChanged; selectGitDecorations
    // returns the same reference for the same session via its WeakMap cache.
    void gitSession;
    return selectGitDecorations(useGitStore.getState(), workspaceId, rootAbsPath);
  }, [gitSession, workspaceId, rootAbsPath]);

  const decorationLookup = useMemo<FileTreeDecorationLookup>(() => {
    // Read once per render — Zustand provides stable function identities.
    const enqueueCheck = useIgnoredStore.getState().enqueueCheck;
    const isIgnoredFn = useIgnoredStore.getState().isIgnored;
    return {
      decoration: (absPath, isDir) =>
        isDir ? decorationMaps.folders.get(absPath) : decorationMaps.files.get(absPath),
      isIgnored: (absPath, isDir) => {
        if (!repoTopLevel) return false;
        // Skip if the entry already has a status decoration — a file cannot be
        // ignored at the same time (untracked vs ignored is mutually exclusive
        // in porcelain v2), and a folder carrying one holds changes git tracks.
        // Folders go through the same check-ignore batch: git resolves a bare
        // `dist` against a dir-only `dist/` pattern via the on-disk type.
        if ((isDir ? decorationMaps.folders : decorationMaps.files).has(absPath)) return false;
        const flag = isIgnoredFn(workspaceId, absPath);
        if (flag === undefined) {
          // Compute relPath for the IPC call. Forward-slash join is safe
          // because the file-tree itself uses forward slashes throughout.
          const root = repoTopLevel.replace(/[\\/]+$/, "");
          if (absPath.startsWith(`${root}/`)) {
            const relPath = absPath.slice(root.length + 1);
            enqueueCheck(workspaceId, absPath, relPath);
          }
          return false;
        }
        // ignoredVersion is read in the outer subscriber — referenced here
        // to keep the dependency live for re-renders when batch flushes
        // arrive.
        void ignoredVersion;
        return flag;
      },
    };
  }, [decorationMaps, workspaceId, repoTopLevel, ignoredVersion]);

  // Anchor for the right-click menu — set in the row's onContextMenu (bubble
  // phase) so it lands in state before Radix's Trigger opens the menu.
  // Phase C: now an array so multi-selection context menus can batch-delete.
  const [contextTargets, setContextTargets] = useState<FileTreeActionTarget[]>([]);

  const pendingCreate = useFileTreePendingCreate({ workspaceId, rootAbsPath });
  const pendingRename = useFileTreePendingRename({ workspaceId, rootAbsPath });

  // Drag-and-drop: container-level native event listener for file move/copy.
  useFileTreeDropTarget({ containerRef, workspaceId, workspaceRootPath: rootAbsPath });

  // New-File / New-Folder need their inline-edit row mounted *after* the
  // ContextMenu's FocusScope releases — see useContextMenuHandoff for
  // the reasoning. Generic items (Reveal, Copy Path) skip the handoff
  // entirely, so Radix's default trigger refocus still runs for them.
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

  // Inject the pending-create sentinel row into the flat list at the
  // right child position. Recomputed on every render — cheap pure
  // function over an already-cheap flat array.
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

  // ---------------------------------------------------------------------------
  // Auto-reveal: highlight in the tree the file the active editor tab points to
  // ---------------------------------------------------------------------------
  // Tab clicks, keyboard navigation and external reveals are all handled by the same effect.
  //
  // VSCode parity (explorerView.ts `selectActiveFile`): auto-reveal triggers
  // *only when the active editor changes*. It does not react to tree mutations (folding or
  // expanding folders). So if the user collapses the active file's parent, it stays
  // collapsed, and the parent is expanded again the moment they go to another tab and come
  // back (= activeEditor changes again).
  //
  // lastRevealedRef records the activeEditorAbsPath that Phase 2 revealed successfully.
  // Both Phase 1 and 2 guard "already handled paths" with this ref, so even if flat changes,
  // reveal/focus-sync is not run again for the same editor path. When activeEditorAbsPath
  // changes to another value, ref != new value and the guard is released.
  const lastRevealedRef = useRef<string | null>(null);

  // Phase 1: expand the parent directories. reveal() adds the ancestors to expanded and
  // loads the needed children over IPC. Paths outside the workspace root are ignored.
  //
  // Why flat is in deps: tree init / child loading is async, so the tree may not exist yet
  // when the effect first runs. Until Phase 2 sets the ref, it retries on every flat change.
  //
  // lastRevealedRef guard: once Phase 2 has finished a reveal, reveal is not called again
  // even if the user collapses the parent and flat loses the leaf again — VSCode parity.
  useEffect(() => {
    if (!activeEditorAbsPath) return;
    if (activeEditorAbsPath !== rootAbsPath && !activeEditorAbsPath.startsWith(`${rootAbsPath}/`)) {
      return;
    }
    if (lastRevealedRef.current === activeEditorAbsPath) return;
    if (flat.some((f) => f.absPath === activeEditorAbsPath)) return;
    void reveal(workspaceId, activeEditorAbsPath);
  }, [activeEditorAbsPath, workspaceId, rootAbsPath, flat]);

  // Phase 2: once the flat list contains the path, update activeIndex + scroll.
  // When reveal() loads children asynchronously, flat changes and this effect runs again to
  // find the index. If it is not in flat yet this is a no-op, and it retries after the next
  // store update (child load finished).
  //
  // lastRevealedRef guard: an editor path that was already revealed is not revealed again.
  // Without the guard, the moment the user clicks a folder (flat changes via toggleExpand)
  // this effect would rerun and reset activeIndex to the "open editor file", and the sync
  // effect would overwrite the store's activeAbsPath too, losing the manual selection — the
  // cause of the bug where the copy/paste target became the editor file's parent (root)
  // instead of the selected folder. If idx<0 (not in flat yet) the ref is not updated, so it
  // retries after the children load.
  useEffect(() => {
    if (!activeEditorAbsPath) return;
    if (lastRevealedRef.current === activeEditorAbsPath) return;
    const idx = flat.findIndex((f) => f.absPath === activeEditorAbsPath);
    if (idx < 0) return;
    lastRevealedRef.current = activeEditorAbsPath;
    // Phase F: selection-friendly auto-reveal (preserves multi-select when
    // the newly-active file is already in the selection set).
    revealEditorActiveFile(workspaceId, activeEditorAbsPath);
    virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [activeEditorAbsPath, flat, virtualizer, workspaceId]);

  // NOTE: Don't return early on empty `flat` — the StatusView used to be
  // returned in a separate JSX branch when no rows were present, but that
  // meant `containerRef` was never attached during the empty pose. When
  // the first non-empty tree arrived and the virtual body suddenly took
  // over the JSX, `@tanstack/react-virtual` had been initialized against
  // a null scroll element and its ResizeObserver attached too late —
  // leaving the container measurement stuck at the parent's collapsed
  // size and rendering only ~1 row of overscan even when 18 rows had
  // loaded. We now always render the scrollable container, and swap the
  // *inner* content between StatusView and VirtualBody so the virtualizer
  // sees a stable scroll element from mount-time onwards.
  // Status view (loading / error / "empty folder") only makes sense when the
  // user is actually trying to look at the root's children. If the user has
  // explicitly collapsed the root via the header chevron, an empty area is
  // the correct pose — showing "This folder is empty" would misrepresent
  // intentional collapse as a content-absence state.
  //
  // Gate on `displayFlat` rather than `flat`: when the tree is empty and the
  // user triggers New File / New Folder, `flat` is still empty but
  // `getDisplayFlat` injects the inline-edit sentinel row (a root-anchored
  // pending create yields `displayFlat = [sentinel]`). That row only renders
  // inside <FileTreeVirtualBody>, so keying off `flat.length` would leave the
  // StatusView mounted, the edit row never appears, and the create silently
  // dies — the empty-tree "create buttons do nothing" bug.
  const showStatusView = displayFlat.length === 0 && rootExpanded;

  // Build the flat path list once per render (same shape as what
  // extendSelectionTo/selectAllVisible need). Declared before handleKeyDown
  // and handleRowClick so both closures capture the same stable reference.
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

    // WAI-ARIA tree widget pattern: rows are `tabIndex={-1}` and the container
    // owns the single tab stop (`tabIndex={0}`). Clicking a `<button tabIndex=-1>`
    // does NOT reliably move keyboard focus to it on macOS Chromium — focus can
    // remain on whatever element had it before the click (body, previously-active
    // Monaco, ...). Without an explicit move, subsequent shortcuts that gate on
    // `fileTreeFocus` (Backspace = delete, Cmd+A = hierarchical select-all)
    // silently no-op because the keydown's `closest('[role="tree"]')` walk
    // fails from the unrelated focus target.
    //
    // Refocusing the container on every row interaction is the same trick VSCode's
    // listWidget uses (focus stays on the list element, `aria-activedescendant`
    // surfaces the active row). `preventScroll` prevents the browser from
    // re-aligning the scroll container when focus moves.
    containerRef.current?.focus({ preventScroll: true });

    if (e?.shiftKey) {
      // Shift-click: extend range from anchor to this row.
      store.extendSelectionTo(workspaceId, item.absPath, flatPaths);
      // Do not open the file or toggle the dir on range extension.
      return;
    }

    if (e?.metaKey || e?.ctrlKey) {
      // Cmd/Ctrl-click: toggle this path in/out of the selection set.
      // Does NOT open the file — open-to-side was moved to Cmd+\\ keybinding.
      store.toggleSelection(workspaceId, item.absPath);
      return;
    }

    // Plain click: single-select + primary action.
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
    // VSCode parity: double-click in the explorer opens the file as a
    // permanent tab (no preview slot, no italic title) and moves focus into
    // it, while a single click leaves focus in the tree. Goes through
    // openOrRevealEditor so existing-tab reveal still applies.
    const { tabId } = openOrRevealEditor(
      { workspaceId, filePath: item.absPath },
      { preview: false },
    );
    requestTabFocus(tabId);
  }

  // The active path for the virtual-body comes directly from the store focus.
  // `flat[activeIndex]?.absPath` would be equivalent but reading focusPath
  // avoids an extra flat lookup and keeps a single source of truth.
  const activeAbsPath = focusPath ?? undefined;

  // Per-row selection checker: returns true when the row is in the explicit
  // selection set (not just focused). Using selectIsSelected with getState()
  // inside a render-time callback avoids creating a Zustand subscription per
  // row while still reading the latest state at render time (the parent
  // re-renders whenever `selection` map changes because `focusPath` subscribes).
  const isPathSelected = (absPath: string): boolean =>
    selectIsSelected(useFilesStore.getState(), workspaceId, absPath);

  // ---------------------------------------------------------------------------
  // Cut clipboard overlay (Phase F)
  // ---------------------------------------------------------------------------
  // Subscribe to the clipboard store so cut entries dim via isCut.  We read
  // `kind` + `entries` as primitives so Zustand only re-renders when they
  // actually change (no new-object selector pitfall).
  const clipKind = useFileClipboardStore((s) => s.kind);
  const clipEntries = useFileClipboardStore((s) => s.entries);
  // Build a Set of cut-path strings once per clipboard snapshot.  useMemo
  // keeps the Set reference stable so the isPathCut callback identity does
  // not flip on every render.
  const cutPathSet = useMemo<ReadonlySet<string>>(() => {
    if (clipKind !== "cut") return new Set();
    return new Set(clipEntries.map((e) => e.absPath));
  }, [clipKind, clipEntries]);
  const isPathCut = (absPath: string): boolean => cutPathSet.has(absPath);

  // ---------------------------------------------------------------------------
  // ARIA (Phase F)
  // ---------------------------------------------------------------------------
  // VSCode parity (listView.ts + listWidget.ts):
  //   - Container: role="tree" aria-multiselectable="true"
  //                aria-activedescendant="<focused-row-id>"
  //   - Each row:  id="tree-row-<encoded-path>"
  //
  // The row id must be a valid HTML id — we replace any non-alphanumeric
  // characters with underscores.  AbsPath collisions within a workspace are
  // impossible because absPath is unique.
  function encodeRowId(absPath: string): string {
    return `tree-row-${absPath.replace(/[^a-zA-Z0-9]/g, "_")}`;
  }
  const focusRowId = focusPath ? encodeRowId(focusPath) : undefined;

  // Empty-area right-click → synthesise a root target so the menu still
  // shows New File / New Folder etc. anchored at the workspace root.
  // Row's own onContextMenu fires first (deepest first in the bubble);
  // we only step in when no row sits between the target and us.
  function handleAreaContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (!t.closest('button[role="treeitem"]')) {
      setContextTargets([{ absPath: rootAbsPath, type: "dir", isRoot: true }]);
    }
  }

  // Root header action wiring (VSCode parity, MenuId.ViewTitle/navigation).
  // Refresh / Collapse always target the workspace as a whole. New File /
  // New Folder follow VSCode's `openExplorerAndCreate` (fileActions.ts):
  // resolve the create parent from the currently focused row — a focused
  // dir is itself the parent, a focused file uses its containing dir, and
  // an empty selection falls back to the workspace root. This lets the
  // header buttons act on whichever folder the user just clicked into,
  // matching Explorer behavior. New File / New Folder skip the context-menu
  // handoff because no Radix FocusScope is open when the icon is clicked.
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
    // Right-click anywhere on the header → root-target context menu. The
    // ContextMenuTrigger wrapping us still receives the bubbled event and
    // opens the menu; we only need to populate contextTargets first.
    setContextTargets([{ absPath: rootAbsPath, type: "dir", isRoot: true }]);
  };

  return (
    <ContextMenuRoot onOpenChange={(open) => !open && setContextTargets([])}>
      <ContextMenuTrigger>
        {/*
          Named hover group covering header + virtualized body. The header's
          action cluster reads `group-hover/filetree:opacity-100` so the four
          icons (New File / New Folder / Refresh / Collapse) stay revealed as
          long as the pointer is anywhere over the file-tree pane — matches
          VSCode's title-bar action visibility, which is bound to the whole
          view rather than just its title strip.
         */}
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
            // Empty-area left click → fully clear selection so the next
            // New File / New Folder / Paste lands at the workspace root.
            // Click hits inside any row (regular / pending / rename — all
            // tagged with data-file-tree-row-type) bubble up here too, so
            // the closest() guard ensures we don't undo the row's own
            // setSingleSelection. The container has overflow-auto so the
            // scrollable backdrop below the last row is a legitimate
            // target even when the tree is densely populated.
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
              <FileTreeVirtualBody
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
                    // Right-click selection policy (Phase B — unchanged):
                    // - clicked row is in selection.paths → only move focus (keep selection).
                    // - clicked row is not in selection  → single-select it.
                    const sel = useFilesStore.getState().selection.get(workspaceId);
                    const inSet = sel ? sel.paths.has(item.absPath) : false;
                    if (inSet) {
                      useFilesStore.getState().setFocus(workspaceId, item.absPath);
                    } else {
                      useFilesStore.getState().setSingleSelection(workspaceId, item.absPath);
                    }

                    // Phase C — build contextTargets from the post-update selection.
                    // Re-read selection after update above to reflect the new state.
                    const selAfter = useFilesStore.getState().selection.get(workspaceId);
                    if (selAfter && selAfter.paths.size > 0 && selAfter.paths.has(item.absPath)) {
                      // Multi-select: expose all selected paths as targets.
                      const targets: FileTreeActionTarget[] = [];
                      for (const p of selAfter.paths) {
                        const node = useFilesStore.getState().trees.get(workspaceId)?.nodes.get(p);
                        if (node) targets.push({ absPath: p, type: node.type });
                      }
                      setContextTargets(targets);
                    } else {
                      // Single: just the clicked row.
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

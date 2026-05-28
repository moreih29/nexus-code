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
import {
  ensureRoot,
  reveal,
  revealEditorActiveFile,
  toggleExpand,
} from "../../../state/operations/files";
import { selectFlat, selectIsSelected, useFilesStore } from "../../../state/stores/files";
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
  const flat = useMemo(() => {
    if (!tree) return [];
    return selectFlat(useFilesStore.getState(), workspaceId);
  }, [tree, workspaceId]);

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

  // Active 에디터 탭이 가리키는 파일의 절대경로. editor / editor.diff 만 대상.
  // 터미널·git.commit 등 파일을 가지지 않는 탭이 활성일 때는 null이고, 그러는
  // 동안에는 트리 하이라이트를 건드리지 않는다(기존 상태 유지).
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
        if (isDir) return false;
        if (!repoTopLevel) return false;
        // Skip if the file already has a status decoration — it cannot be
        // ignored at the same time (untracked vs ignored is mutually exclusive
        // in porcelain v2).
        if (decorationMaps.files.has(absPath)) return false;
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
    () => getDisplayFlat(flat, pendingCreate.pending, pendingRename.pending),
    [flat, pendingCreate.pending, pendingRename.pending],
  );

  const virtualizer = useVirtualizer({
    count: displayFlat.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10,
  });

  // ---------------------------------------------------------------------------
  // Auto-reveal: 활성 에디터 탭이 가리키는 파일을 트리에서 하이라이트
  // ---------------------------------------------------------------------------
  // 탭 클릭/키보드 이동/외부 reveal 모두 같은 effect로 처리된다.
  //
  // VSCode parity (explorerView.ts `selectActiveFile`): auto-reveal은
  // *active editor가 바뀔 때만* 트리거된다. 트리 mutation(폴더 접기/펼치기)
  // 에는 반응하지 않는다. 즉 사용자가 활성 파일의 부모를 접으면 접힌 상태가
  // 유지되고, 다른 탭으로 갔다가 돌아오는 순간(=activeEditor가 다시 바뀜)
  // 부모가 재펼쳐진다.
  //
  // lastRevealedRef는 Phase 2가 reveal에 성공한 activeEditorAbsPath를 기록.
  // Phase 1·2 둘 다 이 ref로 "이미 다룬 경로"를 가드해서, flat이 바뀌어도
  // 같은 에디터 경로에 대해 reveal/focus-sync를 다시 실행하지 않는다.
  // activeEditorAbsPath가 다른 값으로 바뀌면 ref ≠ 새 값이라 가드가 풀린다.
  const lastRevealedRef = useRef<string | null>(null);

  // Phase 1: 부모 디렉터리를 펼친다. reveal()이 ancestors를 expanded에 추가하고
  // 필요한 children을 IPC로 로드한다. 워크스페이스 루트 바깥의 경로는 무시.
  //
  // flat을 deps에 두는 이유: 트리 init / 자식 로드가 비동기여서 처음 effect
  // 실행 시점에 tree가 아직 없을 수 있다. Phase 2가 ref를 set하기 전까지는
  // flat 변경마다 재시도된다.
  //
  // lastRevealedRef 가드: Phase 2가 한 번 reveal 완료 후에는, 사용자가 부모를
  // 접어 flat이 다시 leaf를 잃어도 reveal을 재호출하지 않는다 — VSCode parity.
  useEffect(() => {
    if (!activeEditorAbsPath) return;
    if (activeEditorAbsPath !== rootAbsPath && !activeEditorAbsPath.startsWith(`${rootAbsPath}/`)) {
      return;
    }
    if (lastRevealedRef.current === activeEditorAbsPath) return;
    if (flat.some((f) => f.absPath === activeEditorAbsPath)) return;
    void reveal(workspaceId, activeEditorAbsPath);
  }, [activeEditorAbsPath, workspaceId, rootAbsPath, flat]);

  // Phase 2: flat 리스트가 해당 경로를 포함하게 되면 activeIndex 갱신 + 스크롤.
  // reveal()이 비동기로 children을 로드하면 flat이 변하면서 이 effect가 다시
  // 돌아 인덱스를 찾는다. flat에 아직 없는 경우 no-op이 되고, 다음 store
  // 업데이트(자식 로드 완료) 후 재시도된다.
  //
  // lastRevealedRef 가드: 이미 reveal한 에디터 경로는 다시 reveal하지 않는다.
  // 가드가 없으면 사용자가 폴더를 클릭(→ toggleExpand로 flat 변경)하는 순간
  // 이 effect가 재실행되어 activeIndex를 "열려 있는 에디터 파일"로 되돌리고,
  // 동기화 effect가 store의 activeAbsPath까지 덮어써 수동 선택을 잃는다 —
  // 복사/붙여넣기 타깃이 선택한 폴더가 아니라 에디터 파일의 부모(루트)로
  // 잡히던 버그의 원인. idx<0(아직 flat에 없음)이면 ref를 갱신하지 않아
  // 자식 로드 후 재시도된다.
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
  const showStatusView = flat.length === 0;

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
    // permanent tab (no preview slot, no italic title). Goes through
    // openOrRevealEditor so existing-tab reveal still applies.
    openOrRevealEditor({ workspaceId, filePath: item.absPath }, { preview: false });
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

  return (
    <ContextMenuRoot onOpenChange={(open) => !open && setContextTargets([])}>
      <ContextMenuTrigger>
        <div
          ref={containerRef}
          role="tree"
          tabIndex={0}
          aria-multiselectable="true"
          aria-activedescendant={focusRowId}
          onKeyDown={handleKeyDown}
          onContextMenu={handleAreaContextMenu}
          className="h-full overflow-auto app-scrollbar focus:outline-none"
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
      </ContextMenuTrigger>

      <ContextMenuContent onCloseAutoFocus={menuHandoff.onCloseAutoFocus}>
        <ContextMenuItems items={buildFileTreeMenuItems(contextTargets, fileTreeActions)} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

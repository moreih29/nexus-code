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
import { ensureRoot, reveal, toggleExpand } from "../../../state/operations/files";
import { selectFlat, useFilesStore } from "../../../state/stores/files";
import { useGitSession, useGitStore } from "../../../state/stores/git";
import { selectGitDecorations } from "../../../state/stores/git/decorations";
import { useIgnoredStore } from "../../../state/stores/git/ignored";
import { useLayoutStore } from "../../../state/stores/layout";
import { useTabsStore } from "../../../state/stores/tabs";
import { type FileTreeActionTarget, useFileTreeActions } from "../hooks/use-file-tree-actions";
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
  const [contextTarget, setContextTarget] = useState<FileTreeActionTarget | null>(null);

  const pendingCreate = useFileTreePendingCreate({ workspaceId, rootAbsPath });
  const pendingRename = useFileTreePendingRename({ workspaceId, rootAbsPath });

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
  // Phase 1: 부모 디렉터리를 펼친다. reveal()이 ancestors를 expanded에 추가하고
  // 필요한 children을 IPC로 로드한다. 워크스페이스 루트 바깥의 경로는 무시.
  // flat을 deps에 넣어 트리 init 직후 / 자식 로드 직후에도 effect가 다시 돌아
  // 경로가 아직 보이지 않으면 reveal을 재시도한다. 이미 flat에 있으면 no-op.
  useEffect(() => {
    if (!activeEditorAbsPath) return;
    if (activeEditorAbsPath !== rootAbsPath && !activeEditorAbsPath.startsWith(`${rootAbsPath}/`)) {
      return;
    }
    if (flat.some((f) => f.absPath === activeEditorAbsPath)) return;
    void reveal(workspaceId, activeEditorAbsPath);
  }, [activeEditorAbsPath, workspaceId, rootAbsPath, flat]);

  // Phase 2: flat 리스트가 해당 경로를 포함하게 되면 activeIndex 갱신 + 스크롤.
  // reveal()이 비동기로 children을 로드하면 flat이 변하면서 이 effect가 다시
  // 돌아 인덱스를 찾는다. flat에 아직 없는 경우 no-op이 되고, 다음 store
  // 업데이트(자식 로드 완료) 후 재시도된다.
  useEffect(() => {
    if (!activeEditorAbsPath) return;
    const idx = flat.findIndex((f) => f.absPath === activeEditorAbsPath);
    if (idx < 0) return;
    setActiveIndexLocal(idx);
    virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [activeEditorAbsPath, flat, virtualizer]);

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
      toggleExpand(workspaceId, item.absPath);
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
              virtualizer={virtualizer}
              decorationLookup={decorationLookup}
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
              onPendingRenameCommit={async (name) => {
                await pendingRename.commit(name);
              }}
              onPendingRenameCancel={pendingRename.cancel}
            />
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent onCloseAutoFocus={menuHandoff.onCloseAutoFocus}>
        <ContextMenuItems items={buildFileTreeMenuItems(contextTarget, fileTreeActions)} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

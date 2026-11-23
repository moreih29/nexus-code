import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { evaluateContextKey } from "@/keybindings/context-keys";
import { openOrRevealEditor as defaultOpenOrRevealEditor } from "@/services/editor";
import { toggleExpand as defaultToggleExpand } from "@/state/operations/files";
import type { FlatItem, WorkspaceTree } from "@/state/stores/files";
import { parentOf, useFilesStore } from "@/state/stores/files";

export function computeParentJumpIndex(
  flat: FlatItem[],
  currentItem: FlatItem,
  rootAbsPath: string,
): number | null {
  const parentAbs = parentOf(currentItem.absPath, rootAbsPath);
  if (parentAbs === currentItem.absPath) return null;
  const idx = flat.findIndex((i) => i.absPath === parentAbs);
  if (idx < 0) return null;
  return idx;
}

export interface FileTreeKeydownDeps {
  flat: FlatItem[];
  flatPaths: readonly string[];
  tree: WorkspaceTree | undefined;
  workspaceId: string;
  rootAbsPath: string;
  activeIndex: number;
  setActiveIndex: (next: number) => void;
  scrollToIndex: (index: number) => void;
  openOrRevealEditor?: (input: { workspaceId: string; filePath: string }) => void;
  toggleExpand?: (workspaceId: string, absPath: string) => void;
  startRename?: (absPath: string) => void;
}

export function createFileTreeKeydownHandler(
  deps: FileTreeKeydownDeps,
): (e: React.KeyboardEvent<HTMLDivElement>) => void {
  return function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    const ke = e.nativeEvent;
    if (evaluateContextKey("inputFocus", ke) || evaluateContextKey("editorFocus", ke)) return;

    const {
      flat,
      flatPaths,
      tree,
      workspaceId,
      rootAbsPath,
      activeIndex,
      setActiveIndex,
      scrollToIndex,
      openOrRevealEditor = defaultOpenOrRevealEditor,
      toggleExpand = defaultToggleExpand,
      startRename,
    } = deps;
    const item = flat[activeIndex];
    if (!item) return;
    const isDir = item.node.type === "dir";
    const isMac = evaluateContextKey("isMac", ke);
    const isSelectAll = (isMac ? e.metaKey : e.ctrlKey) && e.key === "a";

    if (isSelectAll) {
      e.preventDefault();
      useFilesStore.getState().selectAllVisibleHierarchical(workspaceId, flatPaths, rootAbsPath);
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      const store = useFilesStore.getState();
      const sel = store.selection.get(workspaceId);
      const inSingleOrEmpty =
        !sel ||
        sel.focus === null ||
        (sel.anchor === sel.focus && sel.paths.size === 1 && sel.paths.has(sel.focus));
      if (inSingleOrEmpty) {
        store.clearSelection(workspaceId);
      } else {
        store.clearToFocus(workspaceId);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(flat.length - 1, activeIndex + 1);
      setActiveIndex(next);
      scrollToIndex(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, activeIndex - 1);
      setActiveIndex(next);
      scrollToIndex(next);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (isDir && !tree?.expanded.has(item.absPath)) {
        toggleExpand(workspaceId, item.absPath);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (isDir && tree?.expanded.has(item.absPath)) {
        toggleExpand(workspaceId, item.absPath);
      } else {
        const parentIdx = computeParentJumpIndex(flat, item, rootAbsPath);
        if (parentIdx !== null) {
          setActiveIndex(parentIdx);
          scrollToIndex(parentIdx);
        }
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (isDir) {
        toggleExpand(workspaceId, item.absPath);
      } else {
        openOrRevealEditor({ workspaceId, filePath: item.absPath });
      }
    } else if (e.key === "F2") {
      e.preventDefault();
      const sel = useFilesStore.getState().selection.get(workspaceId);
      if (sel && sel.paths.size > 1) {
        showToast({ kind: "info", message: i18next.t("files:fileTree.renameOneAtATime") });
        return;
      }
      if (item.absPath === rootAbsPath) return;
      if (startRename) {
        startRename(item.absPath);
      } else {
        useFilesStore.getState().requestRename(item.absPath);
      }
    }
  };
}

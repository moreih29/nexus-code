import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { evaluateContextKey } from "@/keybindings/context-keys";
import { openOrRevealEditor as defaultOpenOrRevealEditor } from "@/services/editor";
import { toggleExpand as defaultToggleExpand } from "@/state/operations/files";
import type { FlatItem, WorkspaceTree } from "@/state/stores/files";
import { parentOf, useFilesStore } from "@/state/stores/files";
// `openToSide` (⌘↵) is no longer handled here — the global dispatcher
// fires `COMMANDS.openToSide` with `when: "fileTreeFocus"`, which
// covers any row in the tree without component-local plumbing.
//
// What stays here is the local navigation (Arrows / Enter / Space / Escape /
// Cmd+A) the global dispatcher has no business owning.

/**
 * Returns the flat-list index of the parent dir for the given item, or null if
 * the item is already at the root (no jump should occur).
 *
 * Exported for unit testing — the function is pure and has no React dependencies.
 */
export function computeParentJumpIndex(
  flat: FlatItem[],
  currentItem: FlatItem,
  rootAbsPath: string,
): number | null {
  const parentAbs = parentOf(currentItem.absPath, rootAbsPath);
  if (parentAbs === currentItem.absPath) return null; // already root
  const idx = flat.findIndex((i) => i.absPath === parentAbs);
  if (idx < 0) return null;
  return idx;
}

/**
 * Dependencies handed to the keyboard handler. Bundled into a single
 * options object so the function signature doesn't grow unbounded as
 * navigation responsibilities accrue (e.g. multi-select, find-in-tree).
 *
 * `openOrRevealEditor` and `toggleExpand` are optional: production code uses
 * the real implementations by default; tests inject mocks to exercise the
 * branching logic via the real handler without side effects.
 */
export interface FileTreeKeydownDeps {
  flat: FlatItem[];
  /** Pre-computed absPath list — passed to selectAllVisible / extendSelectionTo. */
  flatPaths: readonly string[];
  tree: WorkspaceTree | undefined;
  workspaceId: string;
  rootAbsPath: string;
  activeIndex: number;
  setActiveIndex: (next: number) => void;
  scrollToIndex: (index: number) => void;
  /** Defaults to the real openOrRevealEditor. Override in tests. */
  openOrRevealEditor?: (input: { workspaceId: string; filePath: string }) => void;
  /** Defaults to the real toggleExpand. Override in tests. */
  toggleExpand?: (workspaceId: string, absPath: string) => void;
  /** Begins inline rename. Called on F2 with single selection. Override in tests. */
  startRename?: (absPath: string) => void;
}

/**
 * Single key-event router for the file-tree container.
 *
 * Extracted from `file-tree.tsx` so the tree component stays focused on
 * rendering. The handler is a closure factory: pass in everything it
 * touches and get back an event handler.
 */
export function createFileTreeKeydownHandler(
  deps: FileTreeKeydownDeps,
): (e: React.KeyboardEvent<HTMLDivElement>) => void {
  return function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    // The handler is bound to the tree's outer container and receives keys
    // bubbled from any descendant — including inline inputs (e.g. the
    // new-file edit row). Bail when the event originated in an editable so
    // typing into the input doesn't double-fire as a tree shortcut: a plain
    // Enter to commit the name would otherwise also toggle the active tree
    // row, visibly collapsing it (or, worse, the root). Arrow keys would
    // shift the tree's active row while the user is mid-edit.
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

    // Cmd/Ctrl+A — hierarchical select-all (VSCode parity).
    // First press: focused row's siblings + their visible descendants.
    // Subsequent presses widen one level until the workspace root is reached
    // (final ceiling = the entire flat list).
    if (isSelectAll) {
      e.preventDefault();
      useFilesStore.getState().selectAllVisibleHierarchical(workspaceId, flatPaths, rootAbsPath);
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      // Two-step deselect, mirroring macOS Finder:
      //
      //   1) Range / multi-select state  → narrow to single focused row
      //      (existing clearToFocus behaviour).
      //   2) Single-row or already empty → fully clear so the next
      //      New File / New Folder / Paste targets the workspace root
      //      via the existing `focus=null → rootAbsPath` fallback.
      //
      // Without step 2 the file tree had no way back to "nothing selected"
      // once the user clicked any row, which left workspace-root creation
      // gated by happening to never click anything (or by accumulating
      // multi-select state and pressing Esc until it collapsed).
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
      // Enter/Space act on the focused row only (multi-select is preserved).
      if (isDir) {
        toggleExpand(workspaceId, item.absPath);
      } else {
        openOrRevealEditor({ workspaceId, filePath: item.absPath });
      }
    } else if (e.key === "F2") {
      e.preventDefault();
      // F2 rename: single-focus only. Multi-select shows a toast and no-ops.
      const sel = useFilesStore.getState().selection.get(workspaceId);
      if (sel && sel.paths.size > 1) {
        showToast({ kind: "info", message: i18next.t("files:fileTree.renameOneAtATime") });
        return;
      }
      // Root cannot be renamed — mirror the guard in the global fileRename command.
      if (item.absPath === rootAbsPath) return;
      if (startRename) {
        startRename(item.absPath);
      } else {
        // Fallback: publish via the store bridge so the PendingRename hook fires.
        useFilesStore.getState().requestRename(item.absPath);
      }
    }
  };
}

import { evaluateContextKey } from "@/keybindings/context-keys";
import { openOrRevealEditor } from "@/services/editor";
import { toggleExpand } from "@/state/operations/files";
import type { FlatItem, WorkspaceTree } from "@/state/stores/files";
import { parentOf } from "@/state/stores/files";
// `openToSide` (⌘↵) is no longer handled here — the global dispatcher
// fires `COMMANDS.openToSide` with `when: "fileTreeFocus"`, which
// covers any row in the tree without component-local plumbing.
//
// What stays here is the local navigation (Arrows / Enter / Space) the
// global dispatcher has no business owning.

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
 */
export interface FileTreeKeydownDeps {
  flat: FlatItem[];
  tree: WorkspaceTree | undefined;
  workspaceId: string;
  rootAbsPath: string;
  activeIndex: number;
  setActiveIndex: (next: number) => void;
  scrollToIndex: (index: number) => void;
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

    const { flat, tree, workspaceId, rootAbsPath, activeIndex, setActiveIndex, scrollToIndex } =
      deps;
    const item = flat[activeIndex];
    if (!item) return;
    const isDir = item.node.type === "dir";

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
    }
  };
}

/**
 * Action layer for the file-tree context menu. Mirrors the
 * useGroupActions pattern used by the tab-strip menu so both menu
 * surfaces follow the same shape: pure factory, returns a handler bag,
 * resolves its target via injected getters.
 *
 * Keeping these out of `file-tree.tsx` avoids growing that component
 * with menu-specific logic and lets the next-step actions (Reveal in
 * Finder, New File, Rename, Delete) plug in without touching the tree
 * rendering / virtualization code.
 */
import { openOrRevealEditor } from "@/services/editor";
import { revealInFinder } from "@/services/fs-mutations";
import { parentOf } from "@/state/stores/files";
import { copyText } from "@/utils/clipboard";
import { relPath } from "@/utils/path";
import type { EntryKind } from "./file-tree-display";

export interface FileTreeActionTarget {
  absPath: string;
  type: "file" | "dir" | "symlink";
  /**
   * True when this target represents the workspace root synthesised
   * from a right-click on an empty area in the tree. Treated as a dir
   * for menu purposes; the menu builder uses this to omit items that
   * make no sense at the root (e.g. Copy Relative Path → "").
   */
  isRoot?: boolean;
}

interface UseFileTreeActionsOptions {
  workspaceId: string;
  rootAbsPath: string;
  getTarget: () => FileTreeActionTarget | null;
  /**
   * Begin an inline-create row for a new file/folder under the
   * resolved parent. The hook owns the parent-resolution rule
   * (dir target → itself; file target → its containing folder; no
   * target → workspace root) so menu callsites stay simple.
   */
  startCreate: (parentAbsPath: string, kind: EntryKind) => void;
}

export function useFileTreeActions({
  workspaceId,
  rootAbsPath,
  getTarget,
  startCreate,
}: UseFileTreeActionsOptions) {
  function resolveCreateParent(): string {
    const t = getTarget();
    if (!t) return rootAbsPath;
    if (t.type === "dir") return t.absPath;
    return parentOf(t.absPath, rootAbsPath);
  }
  function open() {
    const t = getTarget();
    if (!t || t.type !== "file") return;
    openOrRevealEditor({ workspaceId, filePath: t.absPath });
  }

  function openToSide() {
    const t = getTarget();
    if (!t || t.type !== "file") return;
    openOrRevealEditor(
      { workspaceId, filePath: t.absPath },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );
  }

  function copyPath() {
    const t = getTarget();
    if (!t) return;
    copyText(t.absPath);
  }

  function copyRelativePath() {
    const t = getTarget();
    if (!t) return;
    copyText(relPath(t.absPath, rootAbsPath));
  }

  function reveal() {
    const t = getTarget();
    if (!t) return;
    void revealInFinder({
      workspaceId,
      workspaceRootPath: rootAbsPath,
      absPath: t.absPath,
    });
  }

  function newFile() {
    startCreate(resolveCreateParent(), "file");
  }

  function newFolder() {
    startCreate(resolveCreateParent(), "folder");
  }

  return { open, openToSide, copyPath, copyRelativePath, reveal, newFile, newFolder };
}

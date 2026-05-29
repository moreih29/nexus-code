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
import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { openOrRevealEditor } from "@/services/editor";
import {
  handleCopy,
  handleCut,
  handlePaste,
  useFileClipboardStore,
} from "@/services/file-clipboard";
import { confirmAndDeleteBatch, createPathActions, distinctParents } from "@/services/fs-mutations";
import { parentOf } from "@/state/stores/files";
import { relPath } from "@/utils/path";
import type { EntryKind } from "../file-tree/display";

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
  /**
   * Returns the current context-menu targets, already resolved with the
   * Phase B right-click policy:
   *   - clicked row is in selection.paths → [all paths in selection set]
   *   - clicked row is not in selection   → [clicked row only]
   *   - empty-area right-click            → [root-target]
   *
   * Replaces the old `getTarget: () => T | null` (single-target) API.
   */
  getTargets: () => FileTreeActionTarget[];
  /**
   * Begin an inline-create row for a new file/folder under the
   * resolved parent. The hook owns the parent-resolution rule
   * (dir target → itself; file target → its containing folder; no
   * target → workspace root) so menu callsites stay simple.
   */
  startCreate: (parentAbsPath: string, kind: EntryKind) => void;
  /** Begin inline rename for the resolved target. */
  startRename: (absPath: string) => void;
}

export function useFileTreeActions({
  workspaceId,
  rootAbsPath,
  getTargets,
  startCreate,
  startRename,
}: UseFileTreeActionsOptions) {
  // For single-target path actions (reveal, copy path) use the first target.
  const pathActions = createPathActions({
    workspaceId,
    workspaceRootPath: rootAbsPath,
    getAbsPath: () => getTargets()[0]?.absPath ?? null,
  });

  function resolveCreateParent(): string {
    const ts = getTargets();
    const t = ts[0];
    if (!t) return rootAbsPath;
    if (t.type === "dir") return t.absPath;
    return parentOf(t.absPath, rootAbsPath);
  }

  function open() {
    // Single-target only — Open makes no sense for multiple files at once.
    const ts = getTargets();
    const t = ts[0];
    if (!t || t.type !== "file") return;
    openOrRevealEditor({ workspaceId, filePath: t.absPath });
  }

  function openToSide() {
    // Single-target only.
    const ts = getTargets();
    const t = ts[0];
    if (!t || t.type !== "file") return;
    openOrRevealEditor(
      { workspaceId, filePath: t.absPath },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );
  }

  function newFile() {
    startCreate(resolveCreateParent(), "file");
  }

  function newFolder() {
    startCreate(resolveCreateParent(), "folder");
  }

  function rename() {
    const ts = getTargets();
    // Multi-selection rename: inform user and no-op (Phase B parity).
    if (ts.length > 1) {
      showToast({ kind: "info", message: i18next.t("files:fileTree.renameOneAtATime") });
      return;
    }
    const t = ts[0];
    if (!t || t.isRoot) return;
    startRename(t.absPath);
  }

  async function deleteTarget(): Promise<boolean> {
    const ts = getTargets();
    // Filter out root targets — deleting the workspace root is never allowed.
    const deletable = ts.filter((t) => !t.isRoot);
    if (deletable.length === 0) return false;

    return confirmAndDeleteBatch(
      workspaceId,
      rootAbsPath,
      deletable.map((t) => t.absPath),
    );
  }

  // ---------------------------------------------------------------------------
  // Clipboard — Phase D: full multi-selection support.
  // ---------------------------------------------------------------------------

  function copy() {
    const ts = getTargets();
    // Filter root targets — copying the workspace root makes no sense.
    const copyable = ts.filter((t) => !t.isRoot);
    if (copyable.length === 0) return;

    // Apply distinctParents so copying a parent + child doesn't double-copy.
    const absPaths = distinctParents(copyable.map((t) => t.absPath));
    const entries = absPaths.map((abs) => ({
      relPath: relPath(abs, rootAbsPath),
      absPath: abs,
    }));

    handleCopy({ workspaceId, workspaceRootPath: rootAbsPath, entries });

    // N≥2: acknowledge multi-copy (single copy is silent, matching Phase C delete).
    if (entries.length >= 2) {
      showToast({ kind: "info", message: `Copied ${entries.length} items` });
    }
  }

  function cut() {
    const ts = getTargets();
    const cuttable = ts.filter((t) => !t.isRoot);
    if (cuttable.length === 0) return;

    const absPaths = distinctParents(cuttable.map((t) => t.absPath));
    const entries = absPaths.map((abs) => ({
      relPath: relPath(abs, rootAbsPath),
      absPath: abs,
    }));

    handleCut({ workspaceId, workspaceRootPath: rootAbsPath, entries });

    if (entries.length >= 2) {
      showToast({ kind: "info", message: `Cut ${entries.length} items` });
    }
  }

  function paste() {
    const ts = getTargets();
    const t = ts[0];
    void handlePaste(t?.absPath ?? null);
  }

  // Read clipboard state at call time (not a reactive subscription, so this
  // stays a plain factory callable outside React). The menu reads `canPaste`
  // when it is rebuilt, and the right-click that opens the menu already
  // triggers a re-render (setContextTargets), so the value is current.
  const clip = useFileClipboardStore.getState();
  const canPaste = clip.kind !== null && clip.entries.length > 0;

  return {
    open,
    openToSide,
    copyPath: pathActions.copyPath,
    copyRelativePath: pathActions.copyRelativePath,
    reveal: pathActions.revealInFinder,
    newFile,
    newFolder,
    rename,
    delete: deleteTarget,
    copy,
    cut,
    paste,
    canPaste,
  };
}

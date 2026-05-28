/**
 * Paste previously copied/cut entries into a destination folder.
 *
 * Behaviour by clipboard kind:
 *  - "cut":  move each entry via `movePath`.
 *  - "copy": copy each entry via `copyPathWithConflictPrompt` (replace-on-
 *            confirm when the destination already exists).
 *  - null:   no-op.
 *
 * After a successful paste the target directory is refreshed via
 * `loadChildren`. Cut also clears the clipboard automatically.
 */

import { showToast } from "@/components/ui/toast";
import { loadChildren } from "@/state/operations/files";
import { useActiveStore } from "@/state/stores/active";
import { useFilesStore } from "@/state/stores/files";
import { parentOf } from "@/state/stores/files/helpers";
import { basename, relPath } from "@/utils/path";
import { copyPathWithAutoRename, movePath } from "../fs-mutations";
import { useFileClipboardStore } from "./store";

/** True when `candidate` is `ancestor` itself or sits under it. */
function isInsideOrEqual(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

/**
 * Paste the clipboard contents into a destination folder.
 *
 * @param targetAbsPath  The node the paste was invoked on. A directory pastes
 *   into itself; a file pastes into its containing folder. When omitted (e.g.
 *   the keyboard shortcut with no explicit target) the file-tree's current
 *   selection (`activeAbsPath`) is used, falling back to the workspace root.
 */
export async function handlePaste(targetAbsPath?: string | null): Promise<void> {
  const cb = useFileClipboardStore.getState();
  if (!cb.kind || cb.entries.length === 0) return;

  // Cross-workspace guard — if the clipboard workspace doesn't match the
  // active workspace, clear and no-op.
  const activeId = useActiveStore.getState().activeWorkspaceId;
  if (cb.workspaceId !== activeId) {
    useFileClipboardStore.getState().clear();
    return;
  }

  // Resolve the target directory. Prefer the explicit paste target (context
  // menu); otherwise fall back to the file-tree's current selection.
  const tree = useFilesStore.getState().trees.get(cb.workspaceId);
  if (!tree) return;
  const rootAbsPath = tree.rootAbsPath;

  const candidate =
    targetAbsPath ?? useFilesStore.getState().activeAbsPath.get(cb.workspaceId) ?? null;
  let targetDir: string;
  if (candidate === null) {
    targetDir = rootAbsPath;
  } else {
    const node = tree.nodes.get(candidate);
    if (node?.type === "dir") {
      targetDir = candidate;
    } else {
      targetDir = parentOf(candidate, rootAbsPath);
    }
  }

  const kind = cb.kind;

  if (kind === "cut") {
    for (const entry of cb.entries) {
      // Moving an entry into itself or one of its descendants is invalid —
      // most filesystems reject it (EINVAL) and even if they didn't it would
      // be a structural error. VSCode rejects this with a user-facing message;
      // do the same here.
      if (isInsideOrEqual(targetDir, entry.absPath)) {
        showToast({
          kind: "error",
          message: `Can't move "${basename(entry.absPath)}" into itself or a subfolder.`,
        });
        return;
      }
      const ok = await movePath({
        workspaceId: cb.workspaceId,
        workspaceRootPath: cb.sourceRootPath,
        srcAbsPath: entry.absPath,
        dstDirAbsPath: targetDir,
      });
      if (!ok) return;
    }
    await loadChildren(cb.workspaceId, targetDir);
    useFileClipboardStore.getState().clear();
  } else {
    // kind === "copy"
    for (const entry of cb.entries) {
      const name = basename(entry.absPath);
      // VSCode parity: if the user copies a folder and then pastes onto that
      // same folder (or anywhere inside it), the destination falls back to the
      // folder's PARENT — so the result is a sibling "B copy" rather than a
      // recursive "B/B/B/…" tree. Without this guard `copyDir(B, B/B)` would
      // mkdir B/B and then ReadDir(B) snapshots the newly-created child,
      // recursing forever.
      const effectiveDir = isInsideOrEqual(targetDir, entry.absPath)
        ? parentOf(entry.absPath, cb.sourceRootPath)
        : targetDir;
      const dstAbsPath = `${effectiveDir}/${name}`;
      const toRel = relPath(dstAbsPath, cb.sourceRootPath);
      const ok = await copyPathWithAutoRename({
        workspaceId: cb.workspaceId,
        fromRelPath: entry.relPath,
        toRelPath: toRel,
      });
      if (!ok) return;
      // Refresh the directory where the new copy actually landed (it may
      // differ from `targetDir` when we fell back to the parent above).
      await loadChildren(cb.workspaceId, effectiveDir);
    }
  }
}

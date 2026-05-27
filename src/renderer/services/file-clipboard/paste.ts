/**
 * Paste previously copied/cut entries into the active folder.
 *
 * Behaviour by clipboard kind:
 *  - "cut":  move each entry via `movePath`.
 *  - "copy": copy each entry via the `fs.copyFile` IPC.
 *  - null:   no-op.
 *
 * After a successful paste the target directory is refreshed via
 * `loadChildren`. Cut also clears the clipboard automatically.
 */

import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { loadChildren } from "@/state/operations/files";
import { useFilesStore } from "@/state/stores/files";
import { parentOf } from "@/state/stores/files/helpers";
import { useActiveStore } from "@/state/stores/active";
import { basename, relPath } from "@/utils/path";
import { movePath } from "../fs-mutations";
import { useFileClipboardStore } from "./store";

export async function handlePaste(): Promise<void> {
  const cb = useFileClipboardStore.getState();
  if (!cb.kind || cb.entries.length === 0) return;

  // Cross-workspace guard — if the clipboard workspace doesn't match the
  // active workspace, clear and no-op.
  const activeId = useActiveStore.getState().activeWorkspaceId;
  if (cb.workspaceId !== activeId) {
    useFileClipboardStore.getState().clear();
    return;
  }

  // Resolve the target directory from the active path in the file tree.
  const tree = useFilesStore.getState().trees.get(cb.workspaceId);
  if (!tree) return;
  const rootAbsPath = tree.rootAbsPath;

  const activeAbsPath = useFilesStore.getState().activeAbsPath.get(cb.workspaceId) ?? null;
  let targetDir: string;
  if (activeAbsPath === null) {
    targetDir = rootAbsPath;
  } else {
    const node = tree.nodes.get(activeAbsPath);
    if (node?.type === "dir") {
      targetDir = activeAbsPath;
    } else {
      targetDir = parentOf(activeAbsPath, rootAbsPath);
    }
  }

  const kind = cb.kind;

  if (kind === "cut") {
    for (const entry of cb.entries) {
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
      const dstAbsPath = `${targetDir}/${basename(entry.absPath)}`;
      const toRel = relPath(dstAbsPath, cb.sourceRootPath);
      unwrapIpcResult(
        await ipcCallResult("fs", "copyFile", {
          workspaceId: cb.workspaceId,
          fromRelPath: entry.relPath,
          toRelPath: toRel,
        }),
      );
    }
    await loadChildren(cb.workspaceId, targetDir);
  }
}
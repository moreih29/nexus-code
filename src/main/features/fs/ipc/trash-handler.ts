/**
 * fs.trash — move a workspace-relative path to the host OS recycle bin.
 *
 * Local workspaces only. SSH workspaces have no host trash equivalent;
 * the renderer never sends this IPC for a remote workspace (it branches
 * on `workspace.location.kind` and falls back to `fs.removeAll` with a
 * "this cannot be undone" confirmation). If a buggy caller does send it,
 * we surface FS_ERROR.UNSUPPORTED_REMOTE — the same code used by
 * showItemInFolder — so the toast routing already in place keeps working.
 *
 * Implementation: Electron's `shell.trashItem(absolutePath)` is the
 * cross-platform host bridge (macOS NSWorkspace → Finder Trash, Linux
 * gvfs / kio-trash, Windows SHFileOperation → Recycle Bin).
 *
 * ENOENT is treated as idempotent: a stale tree row whose underlying
 * file has disappeared between refresh and click should not surface as a
 * user-facing error — matches the posture of `fs.removeAll` (Go agent
 * returns success on missing) and the `read-handlers.ts` envelope path.
 */

import fs from "node:fs";
import { FS_ERROR, fsCodeFromErrno, fsErrorMessage } from "../../../../shared/fs/errors";
import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import { getElectronSystemShell, type SystemShell } from "../../shell/open-path";
import { UnsupportedSshWorkspaceError } from "../../workspace/guards";
import type { WorkspaceManager } from "../../workspace/manager";
import { resolveLocalWorkspacePath } from "../../workspace/path-safety";

const c = ipcContract.fs.call;

export function trashHandler(
  manager: WorkspaceManager,
  shellImpl: Pick<SystemShell, "trashItem"> = getElectronSystemShell(),
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.trash.args, args);

    let abs: string;
    try {
      abs = resolveLocalWorkspacePath(manager, workspaceId, relPath, "move to trash");
    } catch (e: unknown) {
      if (e instanceof UnsupportedSshWorkspaceError) {
        throw new Error(fsErrorMessage(FS_ERROR.UNSUPPORTED_REMOTE, workspaceId));
      }
      throw e;
    }

    // Pre-check existence. Without this, `shell.trashItem` on a missing
    // path surfaces as a generic "Failed to move … to trash" message that
    // hasFsErrorCode cannot classify. We mirror `fs.removeAll`'s
    // idempotent-missing posture instead.
    try {
      await fs.promises.access(abs);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // idempotent no-op
      const mapped = fsCodeFromErrno(code);
      if (mapped) throw new Error(fsErrorMessage(mapped, abs));
      throw e;
    }

    try {
      await shellImpl.trashItem(abs);
    } catch (e: unknown) {
      // shell.trashItem doesn't expose errno-shaped codes — surface as a
      // generic permission-denied (the most common cause on macOS when
      // the destination's parent is non-writable / SIP-protected).
      const errno = (e as NodeJS.ErrnoException).code;
      const mapped = fsCodeFromErrno(errno);
      if (mapped) throw new Error(fsErrorMessage(mapped, abs));
      throw new Error(fsErrorMessage(FS_ERROR.PERMISSION_DENIED, abs));
    }
  };
}

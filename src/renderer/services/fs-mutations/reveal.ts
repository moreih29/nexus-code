/**
 * Reveal-in-Finder service.
 *
 * Wraps the `fs.showItemInFolder` IPC, computes the workspace-relative
 * path from an absolute file/folder path, and surfaces failure as a
 * toast (no exception bubbling — the menu callsite has nothing useful
 * to do with one).
 *
 * Lives in `services/fs-mutations/` so the next IPC-driven mutations
 * (rename / delete / new file) can land alongside it without touching
 * existing call sites.
 */

import { showToast } from "@/components/ui/toast";
import { ipcCall } from "@/ipc/client";
import { relPath } from "@/utils/path";
import { toFsToast } from "./errors";

export interface RevealInput {
  workspaceId: string;
  workspaceRootPath: string;
  /** Absolute path of the file or folder to reveal. */
  absPath: string;
}

export async function revealInFinder(input: RevealInput): Promise<void> {
  const rel = relPath(input.absPath, input.workspaceRootPath);
  // Reject if the target doesn't sit inside the workspace root — the
  // IPC's resolveSafe would error anyway, but checking here lets us
  // produce a clearer toast.
  if (rel === input.absPath) {
    showToast({
      kind: "error",
      message: "This item is outside the workspace.",
    });
    return;
  }

  try {
    await ipcCall("fs", "showItemInFolder", {
      workspaceId: input.workspaceId,
      relPath: rel,
    });
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: "Couldn't reveal in Finder.",
      notFound: "File no longer exists on disk.",
    });
  }
}

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

import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
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
  // IPC's local workspace path guard would error anyway, but checking here lets us
  // produce a clearer toast.
  if (rel === input.absPath) {
    showToast({
      kind: "error",
      message: i18next.t("files:fileTree.reveal.outsideWorkspace"),
    });
    return;
  }

  try {
    unwrapIpcResult(
      await ipcCallResult("fs", "showItemInFolder", {
        workspaceId: input.workspaceId,
        relPath: rel,
      }),
    );
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: i18next.t("files:fileTree.reveal.failed"),
      notFound: i18next.t("files:fileTree.reveal.notFound"),
      unsupportedRemote: i18next.t("files:fileTree.reveal.localOnly"),
    });
  }
}

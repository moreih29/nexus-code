import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { relPath } from "@/utils/path";
import { toFsToast } from "./errors";

export interface RevealInput {
  workspaceId: string;
  workspaceRootPath: string;
  absPath: string;
}

export async function revealInFinder(input: RevealInput): Promise<void> {
  const rel = relPath(input.absPath, input.workspaceRootPath);
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

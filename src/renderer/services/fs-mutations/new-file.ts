import i18next from "i18next";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { openOrRevealEditor } from "@/services/editor";
import { requestTabFocus } from "@/services/tab-focus";
import { runFsMutation } from "./helpers";

export interface NewFileInput {
  workspaceId: string;
  workspaceRootPath: string;
  parentAbsPath: string;
  name: string;
}

export async function createNewFile(input: NewFileInput): Promise<boolean> {
  const absPath = `${input.parentAbsPath}/${input.name}`;

  const ok = await runFsMutation({
    ...input,
    ipcAction: async (_abs, rel) => {
      const lastSlash = rel.lastIndexOf("/");
      if (lastSlash > 0) {
        const parentRel = rel.slice(0, lastSlash);
        await ipcCallResult("fs", "mkdir", {
          workspaceId: input.workspaceId,
          relPath: parentRel,
          recursive: true,
        }).then(unwrapIpcResult);
      }
      await ipcCallResult("fs", "createFile", {
        workspaceId: input.workspaceId,
        relPath: rel,
      }).then(unwrapIpcResult);
    },
    errorMessages: {
      fallback: i18next.t("files:fileTree.create.fileFailed"),
      alreadyExists: i18next.t("files:fileTree.fsError.nameTaken"),
    },
  });

  if (!ok) return false;

  const { tabId } = openOrRevealEditor(
    { workspaceId: input.workspaceId, filePath: absPath },
    { preview: false },
  );
  requestTabFocus(tabId);

  return true;
}

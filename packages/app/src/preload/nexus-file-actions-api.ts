import { createRequire } from "node:module";

import type { IpcRenderer } from "electron";

import { FILE_ACTIONS_INVOKE_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import type {
  FileActionStartFileDragRequest,
  FileActionStartFileDragResult,
  FileActionsRequest,
  FileActionsResult,
} from "../common/file-actions";

type IpcRendererLike = Pick<IpcRenderer, "invoke">;
const requireElectron = createRequire(import.meta.url);

export interface NexusFileActionsApi {
  invoke<TRequest extends FileActionsRequest>(request: TRequest): Promise<FileActionsResult>;
  startFileDrag(request: Omit<FileActionStartFileDragRequest, "type">): Promise<FileActionStartFileDragResult>;
  getPathForFile(file: File): string;
}

export function createNexusFileActionsApi(ipcRenderer: IpcRendererLike): NexusFileActionsApi {
  return {
    invoke(request) {
      return ipcRenderer.invoke(FILE_ACTIONS_INVOKE_CHANNEL, request);
    },
    async startFileDrag(request) {
      const result = await ipcRenderer.invoke(FILE_ACTIONS_INVOKE_CHANNEL, {
        type: "file-actions/start-file-drag",
        ...request,
      } satisfies FileActionStartFileDragRequest);
      if (!isStartFileDragResult(result)) {
        throw new Error("startFileDrag returned an unexpected result.");
      }
      return result;
    },
    getPathForFile(file) {
      return getElectronWebUtils().getPathForFile(file);
    },
  };
}

export type { FileActionsRequest, FileActionsResult };

function isStartFileDragResult(result: FileActionsResult): result is FileActionStartFileDragResult {
  return result.type === "file-actions/start-file-drag/result";
}

function getElectronWebUtils(): { getPathForFile(file: File): string } {
  const electronModule = requireElectron("electron") as {
    webUtils?: { getPathForFile(file: File): string };
  };
  if (!electronModule.webUtils) {
    return {
      getPathForFile() {
        throw new Error("Electron webUtils is unavailable in this runtime.");
      },
    };
  }

  return electronModule.webUtils;
}

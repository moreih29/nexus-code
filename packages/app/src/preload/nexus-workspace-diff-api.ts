import type { IpcRenderer } from "electron";

import { WORKSPACE_DIFF_READ_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import type {
  WorkspaceDiffRequest,
  WorkspaceDiffResult,
} from "../../../shared/src/contracts/workspace/workspace-diff";

type IpcRendererLike = Pick<IpcRenderer, "invoke">;

export interface NexusWorkspaceDiffApi {
  readWorkspaceDiff(request: WorkspaceDiffRequest): Promise<WorkspaceDiffResult>;
}

export function createNexusWorkspaceDiffApi(
  ipcRenderer: IpcRendererLike,
): NexusWorkspaceDiffApi {
  return {
    readWorkspaceDiff(request) {
      return ipcRenderer.invoke(WORKSPACE_DIFF_READ_CHANNEL, request);
    },
  };
}

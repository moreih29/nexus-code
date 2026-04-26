import type { IpcRenderer } from "electron";

import { CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import type {
  ClaudeTranscriptReadRequest,
  ClaudeTranscriptReadResult,
} from "../../../shared/src/contracts/e3-surfaces";

type IpcRendererLike = Pick<IpcRenderer, "invoke">;

export interface NexusClaudeSessionApi {
  readTranscript(
    request: ClaudeTranscriptReadRequest,
  ): Promise<ClaudeTranscriptReadResult>;
}

export function createNexusClaudeSessionApi(
  ipcRenderer: IpcRendererLike,
): NexusClaudeSessionApi {
  return {
    readTranscript(request) {
      return ipcRenderer.invoke(CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL, request);
    },
  };
}

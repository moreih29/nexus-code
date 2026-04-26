import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL,
  WORKSPACE_DIFF_READ_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type {
  ClaudeTranscriptReadRequest,
  ClaudeTranscriptReadResult,
  WorkspaceDiffRequest,
  WorkspaceDiffResult,
} from "../../../shared/src/contracts/e3-surfaces";
import type { ClaudeSessionTranscriptService } from "./claude-session-transcript-service";
import type { WorkspaceDiffService } from "./workspace-diff-service";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;

type E3SurfaceIpcChannel =
  | typeof WORKSPACE_DIFF_READ_CHANNEL
  | typeof CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL;

const E3_SURFACE_IPC_CHANNELS: E3SurfaceIpcChannel[] = [
  WORKSPACE_DIFF_READ_CHANNEL,
  CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL,
];

export interface E3SurfaceIpcHandlersOptions {
  ipcMain: IpcMainLike;
  workspaceDiffService: Pick<WorkspaceDiffService, "readWorkspaceDiff">;
  claudeSessionTranscriptService: Pick<ClaudeSessionTranscriptService, "readTranscript">;
}

export interface E3SurfaceIpcHandlers {
  dispose(): void;
}

export function registerE3SurfaceIpcHandlers(
  options: E3SurfaceIpcHandlersOptions,
): E3SurfaceIpcHandlers {
  options.ipcMain.handle(
    WORKSPACE_DIFF_READ_CHANNEL,
    (_event: IpcMainInvokeEvent, request: WorkspaceDiffRequest): Promise<WorkspaceDiffResult> => {
      return options.workspaceDiffService.readWorkspaceDiff(request);
    },
  );

  options.ipcMain.handle(
    CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL,
    (
      _event: IpcMainInvokeEvent,
      request: ClaudeTranscriptReadRequest,
    ): Promise<ClaudeTranscriptReadResult> => {
      return options.claudeSessionTranscriptService.readTranscript(request);
    },
  );

  return {
    dispose() {
      for (const channel of E3_SURFACE_IPC_CHANNELS) {
        options.ipcMain.removeHandler(channel);
      }
    },
  };
}

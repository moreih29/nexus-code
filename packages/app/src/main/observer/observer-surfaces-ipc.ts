import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL,
  WORKSPACE_DIFF_READ_CHANNEL,
} from "../../../../shared/src/contracts/ipc-channels";
import type {
  ClaudeTranscriptReadRequest,
  ClaudeTranscriptReadResult,
} from "../../../../shared/src/contracts/claude/claude-session-transcript";
import type {
  WorkspaceDiffRequest,
  WorkspaceDiffResult,
} from "../../../../shared/src/contracts/workspace/workspace-diff";
import type { ClaudeSessionTranscriptService } from "../claude/claude-session-transcript-service";
import type { WorkspaceDiffService } from "../workspace/diff/workspace-diff-service";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;

type ObserverSurfacesIpcChannel =
  | typeof WORKSPACE_DIFF_READ_CHANNEL
  | typeof CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL;

const OBSERVER_SURFACES_IPC_CHANNELS: ObserverSurfacesIpcChannel[] = [
  WORKSPACE_DIFF_READ_CHANNEL,
  CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL,
];

export interface ObserverSurfacesIpcHandlersOptions {
  ipcMain: IpcMainLike;
  workspaceDiffService: Pick<WorkspaceDiffService, "readWorkspaceDiff">;
  claudeSessionTranscriptService: Pick<ClaudeSessionTranscriptService, "readTranscript">;
}

export interface ObserverSurfacesIpcHandlers {
  dispose(): void;
}

export function registerObserverSurfacesIpcHandlers(
  options: ObserverSurfacesIpcHandlersOptions,
): ObserverSurfacesIpcHandlers {
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
      for (const channel of OBSERVER_SURFACES_IPC_CHANNELS) {
        options.ipcMain.removeHandler(channel);
      }
    },
  };
}

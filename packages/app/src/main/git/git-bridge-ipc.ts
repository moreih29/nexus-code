import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import {
  GIT_BRIDGE_EVENT_CHANNEL,
  GIT_BRIDGE_INVOKE_CHANNEL,
} from "../../../../shared/src/contracts/ipc-channels";
import type {
  GitBranchCreateCommand,
  GitBranchCreateReply,
  GitBranchDeleteCommand,
  GitBranchDeleteReply,
  GitBranchListCommand,
  GitBranchListReply,
  GitCheckoutCommand,
  GitCheckoutReply,
  GitCommitCommand,
  GitCommitReply,
  GitDiffCommand,
  GitDiffReply,
  GitDiscardCommand,
  GitDiscardReply,
  GitFailedEvent,
  GitStageCommand,
  GitStageReply,
  GitStatusCommand,
  GitStatusReply,
  GitUnstageCommand,
  GitUnstageReply,
  GitWatchStartCommand,
  GitWatchStartedReply,
  GitWatchStopCommand,
  GitWatchStoppedReply,
} from "../../../../shared/src/contracts/generated/git-lifecycle";
import type { GitStatusChangeEvent } from "../../../../shared/src/contracts/generated/git-relay";
import type {
  SidecarStartCommand,
  SidecarStartedEvent,
} from "../../../../shared/src/contracts/sidecar/sidecar";

export type GitBridgeRequest =
  | GitStatusCommand
  | GitBranchListCommand
  | GitCommitCommand
  | GitStageCommand
  | GitUnstageCommand
  | GitDiscardCommand
  | GitCheckoutCommand
  | GitBranchCreateCommand
  | GitBranchDeleteCommand
  | GitDiffCommand
  | GitWatchStartCommand
  | GitWatchStopCommand;

export type GitBridgeResult =
  | GitStatusReply
  | GitBranchListReply
  | GitCommitReply
  | GitStageReply
  | GitUnstageReply
  | GitDiscardReply
  | GitCheckoutReply
  | GitBranchCreateReply
  | GitBranchDeleteReply
  | GitDiffReply
  | GitWatchStartedReply
  | GitWatchStoppedReply
  | GitFailedEvent;

export type GitBridgeEvent = GitBridgeResult | GitStatusChangeEvent;

export interface GitBridgeDisposable {
  dispose(): void;
}

export interface GitBridgeClient {
  start(command: SidecarStartCommand): Promise<SidecarStartedEvent>;
  invokeGit(command: GitBridgeRequest): Promise<GitBridgeResult>;
  onGitEvent(listener: (event: GitBridgeEvent) => void): GitBridgeDisposable;
}

export interface GitBridgeIpcHandlersOptions {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  mainWindow: BrowserWindow;
  gitClient: GitBridgeClient;
}

export interface GitBridgeIpcHandlers {
  dispose(): void;
}

export function registerGitBridgeIpcHandlers(
  options: GitBridgeIpcHandlersOptions,
): GitBridgeIpcHandlers {
  const subscription = options.gitClient.onGitEvent((event) => {
    emitGitBridgeEvent(options.mainWindow, event);
  });

  options.ipcMain.handle(
    GIT_BRIDGE_INVOKE_CHANNEL,
    (_event: IpcMainInvokeEvent, request: GitBridgeRequest): Promise<GitBridgeResult> => {
      return invokeGitBridgeRequest(options.gitClient, request);
    },
  );

  return {
    dispose() {
      subscription.dispose();
      options.ipcMain.removeHandler(GIT_BRIDGE_INVOKE_CHANNEL);
    },
  };
}

export async function invokeGitBridgeRequest(
  gitClient: GitBridgeClient,
  request: GitBridgeRequest,
): Promise<GitBridgeResult> {
  if ("cwd" in request) {
    await gitClient.start({
      type: "sidecar/start",
      workspaceId: request.workspaceId,
      workspacePath: request.cwd,
      reason: "workspace-open",
    });
  }

  return gitClient.invokeGit(request);
}

export function emitGitBridgeEvent(
  mainWindow: BrowserWindow,
  event: GitBridgeEvent,
): void {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(GIT_BRIDGE_EVENT_CHANNEL, event);
}

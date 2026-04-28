import { describe, expect, test } from "bun:test";

import {
  GIT_BRIDGE_EVENT_CHANNEL,
  GIT_BRIDGE_INVOKE_CHANNEL,
} from "../../../../shared/src/contracts/ipc-channels";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  emitGitBridgeEvent,
  invokeGitBridgeRequest,
  registerGitBridgeIpcHandlers,
  type GitBridgeClient,
  type GitBridgeEvent,
  type GitBridgeRequest,
} from "./git-bridge-ipc";

const workspaceId = "ws_alpha" as WorkspaceId;

const statusRequest: GitBridgeRequest = {
  type: "git/lifecycle",
  action: "status",
  requestId: "git-1",
  workspaceId,
  cwd: "/tmp/alpha",
};

describe("git-bridge-ipc", () => {
  test("starts sidecar for cwd requests before invoking git", async () => {
    const client = new FakeGitBridgeClient();

    await invokeGitBridgeRequest(client, statusRequest);

    expect(client.started).toEqual([{ workspaceId, workspacePath: "/tmp/alpha" }]);
    expect(client.invoked).toEqual([statusRequest]);
  });

  test("registers invoke handler and forwards events", async () => {
    const ipcMain = new FakeIpcMain();
    const mainWindow = new FakeBrowserWindow();
    const client = new FakeGitBridgeClient();

    const handlers = registerGitBridgeIpcHandlers({
      ipcMain: ipcMain as never,
      mainWindow: mainWindow as never,
      gitClient: client,
    });

    await ipcMain.invoke(statusRequest);
    client.emit(client.replyFor(statusRequest));

    expect(ipcMain.channel).toBe(GIT_BRIDGE_INVOKE_CHANNEL);
    expect(mainWindow.sent).toEqual([
      { channel: GIT_BRIDGE_EVENT_CHANNEL, payload: client.replyFor(statusRequest) },
    ]);

    handlers.dispose();
    expect(ipcMain.removed).toEqual([GIT_BRIDGE_INVOKE_CHANNEL]);
  });

  test("does not emit to destroyed windows", () => {
    const mainWindow = new FakeBrowserWindow();
    mainWindow.destroyed = true;

    emitGitBridgeEvent(mainWindow as never, new FakeGitBridgeClient().replyFor(statusRequest));

    expect(mainWindow.sent).toEqual([]);
  });
});

class FakeGitBridgeClient implements GitBridgeClient {
  public readonly started: Array<{ workspaceId: WorkspaceId; workspacePath: string }> = [];
  public readonly invoked: GitBridgeRequest[] = [];
  private listener: ((event: GitBridgeEvent) => void) | null = null;

  public async start(command: { workspaceId: WorkspaceId; workspacePath: string }) {
    this.started.push({ workspaceId: command.workspaceId, workspacePath: command.workspacePath });
    return {
      type: "sidecar/started" as const,
      workspaceId: command.workspaceId,
      pid: 100,
      startedAt: "2026-04-28T00:00:00.000Z",
    };
  }

  public async invokeGit(command: GitBridgeRequest) {
    this.invoked.push(command);
    return this.replyFor(command);
  }

  public onGitEvent(listener: (event: GitBridgeEvent) => void) {
    this.listener = listener;
    return {
      dispose: () => {
        this.listener = null;
      },
    };
  }

  public emit(event: GitBridgeEvent): void {
    this.listener?.(event);
  }

  public replyFor(request: GitBridgeRequest) {
    return {
      type: "git/lifecycle" as const,
      action: "status_result" as const,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      cwd: "cwd" in request ? request.cwd : "/tmp/alpha",
      summary: {
        branch: "main",
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
      },
      generatedAt: "2026-04-28T00:00:00.000Z",
    };
  }
}

class FakeIpcMain {
  public channel: string | null = null;
  public removed: string[] = [];
  private handler: ((event: unknown, request: GitBridgeRequest) => Promise<unknown>) | null = null;

  public handle(channel: string, handler: (event: unknown, request: GitBridgeRequest) => Promise<unknown>): void {
    this.channel = channel;
    this.handler = handler;
  }

  public removeHandler(channel: string): void {
    this.removed.push(channel);
    this.handler = null;
  }

  public invoke(request: GitBridgeRequest): Promise<unknown> {
    if (!this.handler) {
      throw new Error("handler not registered");
    }
    return this.handler({}, request);
  }
}

class FakeBrowserWindow {
  public destroyed = false;
  public readonly sent: Array<{ channel: string; payload: GitBridgeEvent }> = [];
  public readonly webContents = {
    isDestroyed: () => false,
    send: (channel: string, payload: GitBridgeEvent) => {
      this.sent.push({ channel, payload });
    },
  };

  public isDestroyed(): boolean {
    return this.destroyed;
  }
}

import { describe, expect, mock, test } from "bun:test";
import type { BrowserWindow } from "electron";

import {
  EDITOR_BRIDGE_EVENT_CHANNEL,
  EDITOR_BRIDGE_INVOKE_CHANNEL,
} from "../../../../shared/src/contracts/ipc-channels";
import type {
  EditorBridgeEvent,
  EditorBridgeRequest,
  EditorBridgeResult,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { registerEditorBridgeIpcHandlers } from "./editor-bridge-ipc";

const workspaceId = "ws_editor_bridge_ipc" as WorkspaceId;

describe("registerEditorBridgeIpcHandlers", () => {
  test("routes invoke requests and disposes handler/event subscription", async () => {
    const ipcMain = new FakeIpcMain();
    const mainWindow = createMainWindowMock();
    const editorService = new FakeEditorService();
    const lspService = new FakeLspService();
    const handlers = registerEditorBridgeIpcHandlers({
      ipcMain,
      mainWindow,
      editorService,
      lspService,
    });

    const request: EditorBridgeRequest = {
      type: "workspace-files/file/read",
      workspaceId,
      path: "src/index.ts",
    };
    await expect(ipcMain.invokeRegisteredHandler(request)).resolves.toEqual({
      type: "workspace-files/file/read/result",
      workspaceId,
      path: "src/index.ts",
      content: "export {};\n",
      encoding: "utf8",
      version: "v1",
      readAt: "2026-04-27T00:00:00.000Z",
    });
    expect(editorService.receivedRequests).toEqual([request]);

    const event: EditorBridgeEvent = {
      type: "workspace-files/watch",
      workspaceId,
      path: "src/index.ts",
      kind: "file",
      change: "changed",
      oldPath: null,
      occurredAt: "2026-04-27T00:00:00.000Z",
    };
    editorService.emit(event);
    expect(getWebContentsSendCalls(mainWindow)).toEqual([
      {
        channel: EDITOR_BRIDGE_EVENT_CHANNEL,
        payload: event,
      },
    ]);

    const lspEvent: EditorBridgeEvent = {
      type: "lsp-status/changed",
      workspaceId,
      status: {
        language: "typescript",
        state: "ready",
        serverName: "typescript-language-server",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
    };
    lspService.emit(lspEvent);
    expect(getWebContentsSendCalls(mainWindow)).toEqual([
      {
        channel: EDITOR_BRIDGE_EVENT_CHANNEL,
        payload: event,
      },
      {
        channel: EDITOR_BRIDGE_EVENT_CHANNEL,
        payload: lspEvent,
      },
    ]);

    handlers.dispose();
    editorService.emit({ ...event, path: "src/after-dispose.ts" });
    lspService.emit(lspEvent);

    expect(ipcMain.removedChannels).toEqual([EDITOR_BRIDGE_INVOKE_CHANNEL]);
    expect(getWebContentsSendCalls(mainWindow)).toEqual([
      {
        channel: EDITOR_BRIDGE_EVENT_CHANNEL,
        payload: event,
      },
      {
        channel: EDITOR_BRIDGE_EVENT_CHANNEL,
        payload: lspEvent,
      },
    ]);
  });

  test("routes LSP invoke requests through the editor bridge invoke boundary", async () => {
    const ipcMain = new FakeIpcMain();
    const lspService = new FakeLspService();
    registerEditorBridgeIpcHandlers({
      ipcMain,
      mainWindow: createMainWindowMock(),
      editorService: new FakeEditorService(),
      lspService,
    });

    await expect(
      ipcMain.invokeRegisteredHandler({
        type: "lsp-diagnostics/read",
        workspaceId,
        language: "typescript",
      }),
    ).resolves.toEqual({
      type: "lsp-diagnostics/read/result",
      workspaceId,
      diagnostics: [
        {
          path: "src/index.ts",
          language: "typescript",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
          severity: "error",
          message: "Cannot find name 'missing'.",
          source: "typescript-language-server",
          code: 2304,
        },
      ],
      readAt: "2026-04-27T00:00:00.000Z",
    });
    expect(lspService.receivedRequests).toEqual([
      {
        type: "lsp-diagnostics/read",
        workspaceId,
        language: "typescript",
      },
    ]);
  });
});

class FakeIpcMain {
  public readonly removedChannels: string[] = [];
  private handler:
    | ((_event: unknown, request: EditorBridgeRequest) => Promise<EditorBridgeResult>)
    | null = null;

  public handle(
    channel: string,
    handler: (_event: unknown, request: EditorBridgeRequest) => Promise<EditorBridgeResult>,
  ): void {
    expect(channel).toBe(EDITOR_BRIDGE_INVOKE_CHANNEL);
    this.handler = handler;
  }

  public removeHandler(channel: string): void {
    this.removedChannels.push(channel);
    this.handler = null;
  }

  public invokeRegisteredHandler(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    if (!this.handler) {
      throw new Error("No editor bridge handler registered.");
    }

    return this.handler({}, request);
  }
}

class FakeEditorService {
  public readonly receivedRequests: EditorBridgeRequest[] = [];
  private readonly listeners = new Set<(event: EditorBridgeEvent) => void>();

  public onEvent(listener: (event: EditorBridgeEvent) => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public readFile(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    return Promise.resolve({
      type: "workspace-files/file/read/result",
      workspaceId,
      path: "src/index.ts",
      content: "export {};\n",
      encoding: "utf8",
      version: "v1",
      readAt: "2026-04-27T00:00:00.000Z",
    });
  }

  public readFileTree(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public createFile(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public deleteFile(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public renameFile(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public writeFile(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public readGitBadges(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public emit(event: EditorBridgeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeLspService {
  public readonly receivedRequests: EditorBridgeRequest[] = [];
  private readonly listeners = new Set<(event: EditorBridgeEvent) => void>();

  public onEvent(listener: (event: EditorBridgeEvent) => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public readDiagnostics(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    return Promise.resolve({
      type: "lsp-diagnostics/read/result",
      workspaceId,
      diagnostics: [
        {
          path: "src/index.ts",
          language: "typescript",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
          severity: "error",
          message: "Cannot find name 'missing'.",
          source: "typescript-language-server",
          code: 2304,
        },
      ],
      readAt: "2026-04-27T00:00:00.000Z",
    });
  }

  public readStatus(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public openDocument(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public changeDocument(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public closeDocument(request: EditorBridgeRequest): Promise<EditorBridgeResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public emit(event: EditorBridgeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function createMainWindowMock(): BrowserWindow {
  const sendCalls: Array<{ channel: string; payload: unknown }> = [];
  const webContents = {
    send: mock((channel: string, payload: unknown) => {
      sendCalls.push({ channel, payload });
    }),
    isDestroyed: () => false,
    sendCalls,
  };

  return {
    webContents,
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
}

function getWebContentsSendCalls(
  mainWindow: BrowserWindow,
): Array<{ channel: string; payload: unknown }> {
  return (
    mainWindow.webContents as unknown as {
      sendCalls: Array<{ channel: string; payload: unknown }>;
    }
  ).sendCalls;
}

import { describe, expect, mock, test } from "bun:test";
import type { BrowserWindow } from "electron";

import {
  E4_EDITOR_EVENT_CHANNEL,
  E4_EDITOR_INVOKE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type {
  E4EditorEvent,
  E4EditorRequest,
  E4EditorResult,
} from "../../../shared/src/contracts/e4-editor";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import { registerE4EditorIpcHandlers } from "./e4-editor-ipc";

const workspaceId = "ws_e4_ipc" as WorkspaceId;

describe("registerE4EditorIpcHandlers", () => {
  test("routes invoke requests and disposes handler/event subscription", async () => {
    const ipcMain = new FakeIpcMain();
    const mainWindow = createMainWindowMock();
    const editorService = new FakeEditorService();
    const lspService = new FakeLspService();
    const handlers = registerE4EditorIpcHandlers({
      ipcMain,
      mainWindow,
      editorService,
      lspService,
    });

    const request: E4EditorRequest = {
      type: "e4/file/read",
      workspaceId,
      path: "src/index.ts",
    };
    await expect(ipcMain.invokeRegisteredHandler(request)).resolves.toEqual({
      type: "e4/file/read/result",
      workspaceId,
      path: "src/index.ts",
      content: "export {};\n",
      encoding: "utf8",
      version: "v1",
      readAt: "2026-04-27T00:00:00.000Z",
    });
    expect(editorService.receivedRequests).toEqual([request]);

    const event: E4EditorEvent = {
      type: "e4/file/watch",
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
        channel: E4_EDITOR_EVENT_CHANNEL,
        payload: event,
      },
    ]);

    const lspEvent: E4EditorEvent = {
      type: "e4/lsp-status/changed",
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
        channel: E4_EDITOR_EVENT_CHANNEL,
        payload: event,
      },
      {
        channel: E4_EDITOR_EVENT_CHANNEL,
        payload: lspEvent,
      },
    ]);

    handlers.dispose();
    editorService.emit({ ...event, path: "src/after-dispose.ts" });
    lspService.emit(lspEvent);

    expect(ipcMain.removedChannels).toEqual([E4_EDITOR_INVOKE_CHANNEL]);
    expect(getWebContentsSendCalls(mainWindow)).toEqual([
      {
        channel: E4_EDITOR_EVENT_CHANNEL,
        payload: event,
      },
      {
        channel: E4_EDITOR_EVENT_CHANNEL,
        payload: lspEvent,
      },
    ]);
  });

  test("routes LSP invoke requests through the E4 invoke boundary", async () => {
    const ipcMain = new FakeIpcMain();
    const lspService = new FakeLspService();
    registerE4EditorIpcHandlers({
      ipcMain,
      mainWindow: createMainWindowMock(),
      editorService: new FakeEditorService(),
      lspService,
    });

    await expect(
      ipcMain.invokeRegisteredHandler({
        type: "e4/lsp-diagnostics/read",
        workspaceId,
        language: "typescript",
      }),
    ).resolves.toEqual({
      type: "e4/lsp-diagnostics/read/result",
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
        type: "e4/lsp-diagnostics/read",
        workspaceId,
        language: "typescript",
      },
    ]);
  });
});

class FakeIpcMain {
  public readonly removedChannels: string[] = [];
  private handler:
    | ((_event: unknown, request: E4EditorRequest) => Promise<E4EditorResult>)
    | null = null;

  public handle(
    channel: string,
    handler: (_event: unknown, request: E4EditorRequest) => Promise<E4EditorResult>,
  ): void {
    expect(channel).toBe(E4_EDITOR_INVOKE_CHANNEL);
    this.handler = handler;
  }

  public removeHandler(channel: string): void {
    this.removedChannels.push(channel);
    this.handler = null;
  }

  public invokeRegisteredHandler(request: E4EditorRequest): Promise<E4EditorResult> {
    if (!this.handler) {
      throw new Error("No E4 editor handler registered.");
    }

    return this.handler({}, request);
  }
}

class FakeEditorService {
  public readonly receivedRequests: E4EditorRequest[] = [];
  private readonly listeners = new Set<(event: E4EditorEvent) => void>();

  public onEvent(listener: (event: E4EditorEvent) => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public readFile(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    return Promise.resolve({
      type: "e4/file/read/result",
      workspaceId,
      path: "src/index.ts",
      content: "export {};\n",
      encoding: "utf8",
      version: "v1",
      readAt: "2026-04-27T00:00:00.000Z",
    });
  }

  public readFileTree(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public createFile(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public deleteFile(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public renameFile(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public writeFile(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public readGitBadges(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public emit(event: E4EditorEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeLspService {
  public readonly receivedRequests: E4EditorRequest[] = [];
  private readonly listeners = new Set<(event: E4EditorEvent) => void>();

  public onEvent(listener: (event: E4EditorEvent) => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public readDiagnostics(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    return Promise.resolve({
      type: "e4/lsp-diagnostics/read/result",
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

  public readStatus(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public openDocument(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public changeDocument(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public closeDocument(request: E4EditorRequest): Promise<E4EditorResult> {
    this.receivedRequests.push(request);
    throw new Error("not used");
  }

  public emit(event: E4EditorEvent): void {
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

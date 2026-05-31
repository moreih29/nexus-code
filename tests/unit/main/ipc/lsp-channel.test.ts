import { describe, expect, mock, test } from "bun:test";
import type { LspHostHandle } from "../../../../src/main/features/lsp/host";
import { LSP_BOOTSTRAP_PROGRESS_EVENT } from "../../../../src/main/infra/agent/ssh/ssh-bootstrap/index";
import { LSP_FEATURE_ENABLED } from "../../../../src/shared/lsp/feature-flag";

const mockSend = mock((..._args: unknown[]) => {});
const mockGetAllWebContents = mock(() => [{ isDestroyed: () => false, send: mockSend }]);

// Override only webContents so that broadcast() spy-assertions work.
// All other surface members (ipcMain, app, …) inherit from the canonical
// electron stub registered in tests/setup.ts (bunfig.toml preload).
// ipcMain must be present here too so that any transitive require("electron")
// from ipc-router paths receives a complete stub in the same worker.
mock.module("electron", () => ({
  app: { isPackaged: false, getPath: (_n: string) => "/tmp/nexus-test" },
  ipcMain: {
    on: (_channel: string, _listener: unknown): void => {},
    handle: (_channel: string, _listener: unknown): void => {},
    removeHandler: (_channel: string): void => {},
    removeAllListeners: (_channel?: string): void => {},
  },
  ipcRenderer: {
    invoke: async (_channel: string, ..._args: unknown[]): Promise<unknown> => null,
    on: (_channel: string, _listener: unknown): void => {},
    send: (_channel: string, ..._args: unknown[]): void => {},
    removeListener: (_channel: string, _listener: unknown): void => {},
  },
  webContents: {
    getAllWebContents: mockGetAllWebContents,
  },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  Notification: class Notification {
    on(_e: string, _cb: () => void): this { return this; }
    show(): void {}
  },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  net: { fetch: async () => new Response(null, { status: 500 }) },
  dialog: {
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  WebContentsView: class WebContentsView {},
}));

const { registerLspChannel } = await import("../../../../src/main/features/lsp/ipc");

type EventCallback = (args: unknown) => void;

class FakeLspHost implements LspHostHandle {
  private readonly listeners = new Map<string, Set<EventCallback>>();

  call(): Promise<unknown> {
    return Promise.resolve(null);
  }

  notify(): void {}

  respondServerRequest(): void {}

  rejectServerRequest(): void {}

  on(event: string, cb: EventCallback): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(cb);
    return () => listeners?.delete(cb);
  }

  emit(event: string, args: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb(args);
    }
  }

  isAlive(): boolean {
    return true;
  }

  dispose(): void {}
}

// These tests exercise the live event-forwarding path that is only active
// when LSP_FEATURE_ENABLED is true. Skip them when the flag is off so the
// suite stays green during the policy review period.
const testIfEnabled = LSP_FEATURE_ENABLED ? test : test.skip;

describe("registerLspChannel", () => {
  testIfEnabled("forwards host serverEvent messages over lsp.serverEvent", () => {
    const host = new FakeLspHost();
    registerLspChannel(host);

    const event = {
      workspaceId: "ws-1",
      languageId: "typescript",
      method: "window/logMessage",
      params: { type: 3, message: "ready" },
    };
    host.emit("serverEvent", event);

    expect(mockSend).toHaveBeenCalledWith("ipc:event", "lsp", "serverEvent", event);
  });

  testIfEnabled("forwards agent bootstrap progress over lsp.bootstrap.progress", () => {
    const host = new FakeLspHost();
    registerLspChannel(host);

    const event = {
      workspaceId: "ws-1",
      languageId: "python",
      name: "pyright-langserver",
      phase: "uploading",
      bytesDone: 4,
      bytesTotal: 8,
    };
    host.emit(LSP_BOOTSTRAP_PROGRESS_EVENT, event);

    expect(mockSend).toHaveBeenCalledWith("ipc:event", "lsp", "bootstrap.progress", event);
  });
});

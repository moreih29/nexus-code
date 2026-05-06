import { describe, expect, mock, test } from "bun:test";
import type { LspHostHandle } from "../../../../src/main/hosts/lsp-host";

const mockSend = mock((..._args: unknown[]) => {});
const mockGetAllWebContents = mock(() => [{ isDestroyed: () => false, send: mockSend }]);

mock.module("electron", () => ({
  webContents: {
    getAllWebContents: mockGetAllWebContents,
  },
}));

const { registerLspChannel } = await import("../../../../src/main/ipc/channels/lsp");

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

describe("registerLspChannel", () => {
  test("forwards utility serverEvent messages over lsp.serverEvent", () => {
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
});

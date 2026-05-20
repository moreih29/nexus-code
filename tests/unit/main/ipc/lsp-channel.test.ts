import { describe, expect, mock, test } from "bun:test";
import type { LspHostHandle } from "../../../../src/main/features/lsp/host";
import { LSP_BOOTSTRAP_PROGRESS_EVENT } from "../../../../src/main/infra/agent/ssh/ssh-bootstrap/index";
import { LSP_FEATURE_ENABLED } from "../../../../src/shared/lsp/feature-flag";

const mockSend = mock((..._args: unknown[]) => {});
const mockGetAllWebContents = mock(() => [{ isDestroyed: () => false, send: mockSend }]);

mock.module("electron", () => ({
  webContents: {
    getAllWebContents: mockGetAllWebContents,
  },
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

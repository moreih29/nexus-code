/**
 * Adversarial test exposing the missing clearDiagnosticsTimers call in
 * disposeChannelServers (triggered by channel lifecycle "disposed" event).
 *
 * Risk 2 (URI churn / leakage): when a channel is disposed while a
 * trailing-edge timer is pending, the timer must not fire and push stale
 * diagnostics to the renderer. Currently disposeChannelServers does NOT
 * clear diagnostics timers, unlike handleServerExited.
 *
 * This test is expected to FAIL on the current implementation — confirming
 * the defect for Tester's report.
 */

import { describe, expect, jest, test, afterEach } from "bun:test";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";
import { startAgentLspHost } from "../../../../src/main/features/lsp/agent-host";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

class ChannelDisposeTestChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();

  constructor(public readonly serverId = "srv-chan-dispose") {}

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (method === "lsp.spawn") {
      const correlationId = (params as { correlationId?: string } | undefined)?.correlationId;
      this.emit("lsp.serverAssigned", {
        serverId: this.serverId,
        ...(correlationId ? { correlationId } : {}),
      });
      return {
        serverId: this.serverId,
        capabilities: { textDocumentSync: { openClose: true, change: 2 } },
      } as TResult;
    }
    return {} as TResult;
  }

  fire(_method: string, _params?: unknown): void {}

  on(event: string, callback: ChannelEventCallback): () => void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(callback);
    return () => listeners?.delete(callback);
  }

  onLifecycle(callback: ChannelLifecycleCallback): () => void {
    this.lifecycleListeners.add(callback);
    return () => this.lifecycleListeners.delete(callback);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.eventListeners.get(event) ?? []) {
      listener(payload);
    }
  }

  emitDiagnostics(uri: string, version: number): void {
    this.emit("lsp.message", {
      serverId: this.serverId,
      message: {
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              message: `v${version}`,
            },
          ],
        },
      },
    });
  }

  fireDisposed(): void {
    for (const listener of this.lifecycleListeners) {
      listener({ type: "disposed" });
    }
  }

  dispose(): void {}
}

afterEach(() => {
  jest.useRealTimers();
});

describe("channel disposed lifecycle: stale diagnostics timer must be cleared", () => {
  test("pending trailing-edge timer does not fire after channel disposed event", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(90_000_000));

    const channel = new ChannelDisposeTestChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI = "file:///tmp/ws/chan-dispose.py";
    await host.call("didOpen", {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: "/tmp/ws",
      uri: URI,
      languageId: "python",
      version: 1,
      text: "x = 1\n",
    });

    // Leading-edge emit.
    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    // Schedule a trailing-edge timer within idle window.
    jest.setSystemTime(new Date(90_000_000 + 50));
    channel.emitDiagnostics(URI, 2);
    expect(emitted).toHaveLength(1); // timer pending

    // Fire the channel disposed lifecycle event.
    // This triggers disposeChannelServers which cleans up servers and uriIndex.
    channel.fireDisposed();

    // Advance past the debounce window.
    // If the bug is present, the timer fires and emits stale v2 diagnostics.
    // If fixed, the timer is cancelled and emitted count stays at 1.
    jest.advanceTimersByTime(200);

    // EXPECTED (correct behaviour): still 1 — stale timer was cleared.
    // ACTUAL (bug): 2 — stale timer fires after channel was disposed.
    expect(emitted).toHaveLength(1);

    host.dispose();
  });
});

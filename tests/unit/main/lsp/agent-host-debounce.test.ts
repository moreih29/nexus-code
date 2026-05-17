/**
 * Engineer self-regression tests for the publishDiagnostics per-URI debounce
 * feature in AgentLspHost. These verify the core leading-edge + trailing-edge
 * contract on a minimal channel that does not send implicit diagnostics.
 *
 * Adversarial / lifecycle scenarios are in agent-host-debounce-extra.test.ts.
 */
import { describe, expect, jest, test, afterEach } from "bun:test";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";
import { startAgentLspHost } from "../../../../src/main/features/lsp/agent-host";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const URI_A = "file:///tmp/ws/a.py";
const URI_B = "file:///tmp/ws/b.py";

// ---------------------------------------------------------------------------
// Minimal channel: lsp.spawn resolves immediately, no implicit diagnostics
// ---------------------------------------------------------------------------
class DebounceTestChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();
  readonly serverId = "srv-debounce";

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (method === "lsp.spawn") {
      const correlationId = (params as { correlationId?: string } | undefined)?.correlationId;
      this.emit("lsp.serverAssigned", {
        serverId: this.serverId,
        ...(correlationId ? { correlationId } : {}),
      });
      return {
        serverId: this.serverId,
        capabilities: {
          textDocumentSync: { openClose: true, change: 2 },
        },
      } as TResult;
    }
    return {} as TResult;
  }

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

  // Convenience: push N publishDiagnostics notifications for the given URI.
  emitDiagnostics(uri: string, version: number): void {
    this.emit("lsp.message", {
      serverId: this.serverId,
      message: {
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: `v${version}` }] },
      },
    });
  }

  dispose(): void {}
}

async function openUri(host: ReturnType<typeof startAgentLspHost>, channel: DebounceTestChannel, uri: string): Promise<void> {
  await host.call("didOpen", {
    workspaceId: WORKSPACE_ID,
    workspaceRoot: "/tmp/ws",
    uri,
    languageId: "python",
    version: 1,
    text: "x = 1\n",
  });
}

describe("publishDiagnostics debounce", () => {
  // Ensure fake timers are cleaned up after each test regardless of outcome.
  afterEach(() => {
    jest.useRealTimers();
  });

  test("burst of 50 publishDiagnostics for the same URI emits exactly once after debounce delay", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(1_000_000));

    const channel = new DebounceTestChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    await openUri(host, channel, URI_A);

    // First notification: leading-edge emits immediately (URI is fresh).
    channel.emitDiagnostics(URI_A, 1);
    expect(emitted).toHaveLength(1);

    // Advance time to stay within the 500ms idle window so subsequent
    // notifications are all treated as burst (trailing-edge only).
    jest.setSystemTime(new Date(1_000_000 + 100));

    // Push 49 more notifications — all within the debounce window.
    for (let i = 2; i <= 50; i++) {
      channel.emitDiagnostics(URI_A, i);
    }

    // Timer is pending — no additional emit yet.
    expect(emitted).toHaveLength(1);

    // Advance past the 100ms trailing-edge timer to fire it.
    jest.advanceTimersByTime(101);

    // Exactly one trailing-edge emit — carrying the last payload (v50).
    expect(emitted).toHaveLength(2);
    expect((emitted[1] as { diagnostics: Array<{ message: string }> }).diagnostics[0].message).toBe("v50");

    jest.useRealTimers();
    host.dispose();
  });

  test("first publishDiagnostics after 500ms idle emits immediately (leading-edge)", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2_000_000));

    const channel = new DebounceTestChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    await openUri(host, channel, URI_A);

    // Emit once to prime lastEmittedAt.
    channel.emitDiagnostics(URI_A, 1);
    expect(emitted).toHaveLength(1);

    // Advance past the trailing-edge timer so the pending state is flushed.
    jest.advanceTimersByTime(101);
    // No additional emit (no trailing-edge timer was scheduled after leading-edge).
    expect(emitted).toHaveLength(1);

    // Advance 500ms+ so the URI is in an idle state again.
    jest.setSystemTime(new Date(2_000_000 + 600));

    // Next notification must be a leading-edge immediate emit.
    channel.emitDiagnostics(URI_A, 2);
    expect(emitted).toHaveLength(2);

    jest.useRealTimers();
    host.dispose();
  });

  test("different URIs are debounced independently", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(3_000_000));

    const channel = new DebounceTestChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emittedA: unknown[] = [];
    const emittedB: unknown[] = [];
    host.on("diagnostics", (args) => {
      const payload = args as { uri: string };
      if (payload.uri === URI_A) emittedA.push(args);
      if (payload.uri === URI_B) emittedB.push(args);
    });

    // Open both URIs via separate didOpen calls. The second open reuses the
    // same server (same workspaceId + languageId), so we open b.py after a.py.
    await openUri(host, channel, URI_A);
    await openUri(host, channel, URI_B);

    // Leading-edge emits for both.
    channel.emitDiagnostics(URI_A, 1);
    channel.emitDiagnostics(URI_B, 1);
    expect(emittedA).toHaveLength(1);
    expect(emittedB).toHaveLength(1);

    // Move time forward slightly (within idle window) and send more bursts.
    jest.setSystemTime(new Date(3_000_000 + 50));
    channel.emitDiagnostics(URI_A, 2);
    channel.emitDiagnostics(URI_B, 10);

    // Neither has fired the trailing-edge yet.
    expect(emittedA).toHaveLength(1);
    expect(emittedB).toHaveLength(1);

    // Advance timers — both trailing-edge timers fire.
    jest.advanceTimersByTime(101);

    expect(emittedA).toHaveLength(2);
    expect(emittedB).toHaveLength(2);
    // Each received its own latest payload.
    expect((emittedA[1] as { diagnostics: Array<{ message: string }> }).diagnostics[0].message).toBe("v2");
    expect((emittedB[1] as { diagnostics: Array<{ message: string }> }).diagnostics[0].message).toBe("v10");

    jest.useRealTimers();
    host.dispose();
  });

  test("server exit clears pending timers without emitting stale diagnostics", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(4_000_000));

    const channel = new DebounceTestChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    await openUri(host, channel, URI_A);

    // Leading-edge emit.
    channel.emitDiagnostics(URI_A, 1);
    expect(emitted).toHaveLength(1);

    // Move within idle window and schedule a trailing-edge timer.
    jest.setSystemTime(new Date(4_000_000 + 50));
    channel.emitDiagnostics(URI_A, 2);
    expect(emitted).toHaveLength(1); // timer is pending

    // Server exits — must clear the timer.
    channel.emit("lsp.serverExited", {
      serverId: channel.serverId,
      reason: "signal: killed",
      stderrTail: "",
    });

    // Advance past the debounce delay — the cancelled timer must not fire.
    jest.advanceTimersByTime(200);
    expect(emitted).toHaveLength(1);

    jest.useRealTimers();
    host.dispose();
  });
});

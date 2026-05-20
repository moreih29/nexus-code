/**
 * Additional adversarial verification tests for the publishDiagnostics debounce
 * feature (Task 3). These tests cover the lifecycle scenarios and edge-cases
 * NOT covered by Engineer's self-regression suite.
 *
 * Coverage map:
 *   AC 2a  — didClose flushes pending diagnostics; state cleared so no leakage
 *             on a subsequently re-opened URI.
 *   AC 2b  — handleServerExited clears timers without stale emit (deeper: URI
 *             lookup uses uriIndex snapshot at exit time, not after cleanup).
 *   AC 2c  — dispose after pending timers: no emit fires, map is empty
 *             (verified indirectly via emit-count).
 *   AC 3   — Steady-state leading-edge bypass: 500ms idle → first notification
 *             is emitted synchronously (0 additional timer ticks).
 *   AC 4   — Large-fixture efficiency: 100 URIs × 5 burst notifications.
 *             Emit count with debounce vs without.
 *   AC 5   — Non-publishDiagnostics server notifications (window/showMessage,
 *             window/logMessage, $/progress, workspace/applyEdit /
 *             window/showMessageRequest) are emitted immediately without
 *             touching the diagnostics timer.
 */

import { describe, expect, jest, test, afterEach } from "bun:test";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";
import { startAgentLspHost } from "../../../../src/main/features/lsp/agent-host";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Minimal channel implementation used across all extra tests
// ---------------------------------------------------------------------------
class MinimalChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();

  constructor(public serverId = "srv-extra") {}

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

  emitServerNotification(method: string, params: unknown): void {
    this.emit("lsp.message", {
      serverId: this.serverId,
      message: {
        jsonrpc: "2.0",
        method,
        params,
      },
    });
  }

  dispose(): void {}
}

async function openUri(
  host: ReturnType<typeof startAgentLspHost>,
  uri: string,
  workspaceId = WORKSPACE_ID,
): Promise<void> {
  await host.call("didOpen", {
    workspaceId,
    workspaceRoot: "/tmp/ws",
    uri,
    languageId: "python",
    version: 1,
    text: "x = 1\n",
  });
}

// ---------------------------------------------------------------------------
// Global fake-timer teardown guard
// ---------------------------------------------------------------------------
afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// AC 2a — didClose lifecycle
// ---------------------------------------------------------------------------
describe("AC 2a: didClose lifecycle", () => {
  test("pending trailing-edge timer is flushed synchronously on didClose, not later", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(10_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI = "file:///tmp/ws/close-flush.py";
    await openUri(host, URI);

    // Leading-edge emit.
    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    // Within idle window: schedule a trailing-edge timer.
    jest.setSystemTime(new Date(10_000_000 + 50));
    channel.emitDiagnostics(URI, 2);
    expect(emitted).toHaveLength(1); // timer pending

    // didClose must flush the pending diagnostic BEFORE uriIndex is cleared.
    await host.call("didClose", { workspaceId: WORKSPACE_ID, uri: URI });

    // Flush must have happened immediately (no timer advance needed).
    expect(emitted).toHaveLength(2);
    expect(
      (emitted[1] as { diagnostics: Array<{ message: string }> }).diagnostics[0].message,
    ).toBe("v2");

    // Timer should be cancelled — advancing past the debounce window must
    // NOT produce a third emit.
    jest.advanceTimersByTime(200);
    expect(emitted).toHaveLength(2);

    host.dispose();
  });

  test("after didClose, re-opening the same URI starts with a clean debounce state (no leakage)", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(11_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI = "file:///tmp/ws/reopen.py";
    await openUri(host, URI);

    // Emit diagnostic — leading-edge.
    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    // Schedule a trailing-edge timer by sending within idle window.
    jest.setSystemTime(new Date(11_000_000 + 50));
    channel.emitDiagnostics(URI, 99);
    expect(emitted).toHaveLength(1);

    // Close: flushes v99, clears state.
    await host.call("didClose", { workspaceId: WORKSPACE_ID, uri: URI });
    expect(emitted).toHaveLength(2);

    // Re-open the same URI. The server is the same (same workspace + language).
    await openUri(host, URI);

    // New diagnostics for the re-opened URI must trigger a fresh leading-edge
    // emit (state was cleaned up, not still referencing the old server's payload).
    channel.emitDiagnostics(URI, 3);
    expect(emitted).toHaveLength(3);
    expect(
      (emitted[2] as { diagnostics: Array<{ message: string }> }).diagnostics[0].message,
    ).toBe("v3");

    jest.advanceTimersByTime(200);
    // No extra emit — no stale timer from before close should fire.
    expect(emitted).toHaveLength(3);

    host.dispose();
  });

  test("didClose on URI with no pending timer still removes debounce state cleanly", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(12_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI = "file:///tmp/ws/no-pending.py";
    await openUri(host, URI);

    // Leading-edge emit — timer is null afterwards.
    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    // Advance past trailing-edge window so state is fully quiescent.
    jest.advanceTimersByTime(200);
    expect(emitted).toHaveLength(1);

    // Close with no pending timer — should not emit a second time.
    await host.call("didClose", { workspaceId: WORKSPACE_ID, uri: URI });
    expect(emitted).toHaveLength(1);

    // No stale fire after.
    jest.advanceTimersByTime(200);
    expect(emitted).toHaveLength(1);

    host.dispose();
  });
});

// ---------------------------------------------------------------------------
// AC 2b — handleServerExited: deeper coverage
// ---------------------------------------------------------------------------
describe("AC 2b: handleServerExited deeper coverage", () => {
  test("multiple URIs owned by the exited server all have timers cleared", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(20_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI_1 = "file:///tmp/ws/multi-exit-1.py";
    const URI_2 = "file:///tmp/ws/multi-exit-2.py";
    const URI_3 = "file:///tmp/ws/multi-exit-3.py";

    await openUri(host, URI_1);
    await openUri(host, URI_2);
    await openUri(host, URI_3);

    // Leading-edge emits for all three.
    channel.emitDiagnostics(URI_1, 1);
    channel.emitDiagnostics(URI_2, 1);
    channel.emitDiagnostics(URI_3, 1);
    expect(emitted).toHaveLength(3);

    // Schedule trailing-edge timers on all three within idle window.
    jest.setSystemTime(new Date(20_000_000 + 50));
    channel.emitDiagnostics(URI_1, 2);
    channel.emitDiagnostics(URI_2, 2);
    channel.emitDiagnostics(URI_3, 2);
    expect(emitted).toHaveLength(3); // all timers pending

    // Server exits — all three timers must be cleared.
    channel.emit("lsp.serverExited", {
      serverId: channel.serverId,
      reason: "signal: killed",
      stderrTail: "",
    });

    // Advance well past debounce window — none should fire.
    jest.advanceTimersByTime(500);
    expect(emitted).toHaveLength(3);

    host.dispose();
  });

  test("URIs owned by a different (surviving) server are unaffected by exit of another server", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(21_000_000));

    // Two channels: one for the exited server, one for the surviving server.
    const exitedChannel = new MinimalChannel("srv-exited");
    const survivingChannel = new MinimalChannel("srv-surviving");
    let callCount = 0;
    const manager = {
      getAgentChannel: async (wsId: string) => {
        callCount++;
        return callCount === 1 ? exitedChannel : survivingChannel;
      },
    };

    const host = startAgentLspHost(manager);
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI_EXIT = "file:///tmp/ws/exit-server.py";
    const URI_SURVIVE = "file:///tmp/ws/survive-server.ts";

    // Open python (exited channel) and typescript (surviving channel).
    await host.call("didOpen", {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: "/tmp/ws",
      uri: URI_EXIT,
      languageId: "python",
      version: 1,
      text: "x = 1\n",
    });
    await host.call("didOpen", {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: "/tmp/ws",
      uri: URI_SURVIVE,
      languageId: "typescript",
      version: 1,
      text: "export const x = 1\n",
    });

    // Leading-edge emits.
    exitedChannel.emitDiagnostics(URI_EXIT, 1);
    survivingChannel.emitDiagnostics(URI_SURVIVE, 1);
    expect(emitted).toHaveLength(2);

    // Schedule trailing-edge timers within idle window.
    jest.setSystemTime(new Date(21_000_000 + 50));
    exitedChannel.emitDiagnostics(URI_EXIT, 2);
    survivingChannel.emitDiagnostics(URI_SURVIVE, 2);
    expect(emitted).toHaveLength(2);

    // Only the exited server fires its exit event.
    exitedChannel.emit("lsp.serverExited", {
      serverId: "srv-exited",
      reason: "signal: killed",
      stderrTail: "",
    });

    // Advance timers — surviving URI timer must still fire.
    jest.advanceTimersByTime(200);

    // EXIT server URI: no extra emit. SURVIVE server URI: trailing-edge fires.
    const surviveEmits = (emitted as Array<{ uri: string }>).filter(
      (e) => e.uri === URI_SURVIVE,
    );
    const exitEmits = (emitted as Array<{ uri: string }>).filter(
      (e) => e.uri === URI_EXIT,
    );
    expect(exitEmits).toHaveLength(1); // only leading-edge
    expect(surviveEmits).toHaveLength(2); // leading-edge + trailing-edge

    host.dispose();
  });
});

// ---------------------------------------------------------------------------
// AC 2c — dispose clears timers without stale emit
// ---------------------------------------------------------------------------
describe("AC 2c: dispose lifecycle", () => {
  test("dispose with pending timers produces no further diagnostics emits", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(30_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI = "file:///tmp/ws/dispose-pending.py";
    await openUri(host, URI);

    // Leading-edge emit.
    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    // Schedule trailing-edge timer within idle window.
    jest.setSystemTime(new Date(30_000_000 + 50));
    channel.emitDiagnostics(URI, 2);
    expect(emitted).toHaveLength(1);

    // Dispose must clear the timer.
    host.dispose();

    // Advance past debounce window — no stale emit.
    jest.advanceTimersByTime(500);
    expect(emitted).toHaveLength(1);
  });

  test("dispose with multiple pending timers for multiple URIs: all suppressed", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(31_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URIS = Array.from(
      { length: 10 },
      (_, i) => `file:///tmp/ws/dispose-multi-${i}.py`,
    );

    for (const uri of URIS) {
      await openUri(host, uri);
    }

    // Leading-edge emits for all.
    for (const uri of URIS) {
      channel.emitDiagnostics(uri, 1);
    }
    expect(emitted).toHaveLength(10);

    // Schedule trailing-edge timers within idle window.
    jest.setSystemTime(new Date(31_000_000 + 50));
    for (const uri of URIS) {
      channel.emitDiagnostics(uri, 2);
    }
    expect(emitted).toHaveLength(10);

    // Dispose all timers.
    host.dispose();

    jest.advanceTimersByTime(500);
    // No additional emits.
    expect(emitted).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// AC 3 — Steady-state typing latency (leading-edge bypass)
// ---------------------------------------------------------------------------
describe("AC 3: steady-state typing latency", () => {
  test("first notification after 500ms idle emits synchronously (0 timer ticks needed)", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(40_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI = "file:///tmp/ws/typing-latency.py";
    await openUri(host, URI);

    // Initial emit (leading-edge).
    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    // Advance trailing-edge timer to quiesce.
    jest.advanceTimersByTime(110);
    expect(emitted).toHaveLength(1);

    // Simulate 500ms+ of idle time (no notifications).
    jest.setSystemTime(new Date(40_000_000 + 600));

    // Simulate a single typing character → publishDiagnostics arrives.
    // This must emit IMMEDIATELY without needing any timer advance.
    channel.emitDiagnostics(URI, 2);
    expect(emitted).toHaveLength(2); // immediate — no advanceTimersByTime needed

    // Verify the payload is the one just sent.
    expect(
      (emitted[1] as { diagnostics: Array<{ message: string }> }).diagnostics[0].message,
    ).toBe("v2");

    // No additional timer-driven emit.
    jest.advanceTimersByTime(200);
    expect(emitted).toHaveLength(2);

    host.dispose();
  });

  test("steady-state burst after idle: leading-edge + exactly one trailing-edge", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(41_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI = "file:///tmp/ws/typing-burst.py";
    await openUri(host, URI);

    // Simulate 500ms+ idle.
    jest.setSystemTime(new Date(41_000_000 + 600));

    // Burst of 10 notifications arrives rapidly (all within 100ms).
    for (let i = 1; i <= 10; i++) {
      channel.emitDiagnostics(URI, i);
    }

    // Leading-edge fires immediately on the first one.
    // The other 9 schedule/reschedule the trailing-edge timer.
    expect(emitted).toHaveLength(1);

    // Fire trailing-edge.
    jest.advanceTimersByTime(110);
    expect(emitted).toHaveLength(2);

    // Trailing-edge must carry the LAST payload (v10).
    expect(
      (emitted[1] as { diagnostics: Array<{ message: string }> }).diagnostics[0].message,
    ).toBe("v10");

    host.dispose();
  });
});

// ---------------------------------------------------------------------------
// AC 4 — Large fixture efficiency
// ---------------------------------------------------------------------------
describe("AC 4: large fixture emit efficiency", () => {
  test("100 URIs × 5 burst notifications: emit count reduced by ≥50%", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(50_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI_COUNT = 100;
    const NOTIFICATIONS_PER_URI = 5;

    // Open all URIs.
    const uris = Array.from(
      { length: URI_COUNT },
      (_, i) => `file:///tmp/ws/large-${i}.py`,
    );
    for (const uri of uris) {
      await openUri(host, uri);
    }

    // Without debounce, 100 × 5 = 500 emits total.
    const totalRaw = URI_COUNT * NOTIFICATIONS_PER_URI;

    // Cold open: first notification per URI hits leading-edge → immediate emit.
    // Then set system time within the 500ms idle window so subsequent
    // notifications within the burst are trailing-edge only.
    for (const uri of uris) {
      channel.emitDiagnostics(uri, 1); // leading-edge emit
    }
    // All 100 URIs got their first leading-edge emit.
    expect(emitted).toHaveLength(URI_COUNT);

    // Now send 4 more notifications per URI within the idle window
    // (all within 100ms of each other → trailing-edge debounce).
    jest.setSystemTime(new Date(50_000_000 + 50));
    for (let v = 2; v <= NOTIFICATIONS_PER_URI; v++) {
      for (const uri of uris) {
        channel.emitDiagnostics(uri, v);
      }
    }

    // Trailing-edge timers are pending — no additional emits yet.
    expect(emitted).toHaveLength(URI_COUNT);

    // Fire all trailing-edge timers.
    jest.advanceTimersByTime(200);

    // Each URI now has: 1 leading-edge + 1 trailing-edge = 2 total.
    // Total: 200 emits. Without debounce: 500 emits. Reduction: 60%.
    const totalWithDebounce = emitted.length;
    const reduction = 1 - totalWithDebounce / totalRaw;

    expect(totalWithDebounce).toBe(URI_COUNT * 2); // 200

    // Must be at least 50% reduction.
    expect(reduction).toBeGreaterThanOrEqual(0.5);

    host.dispose();
  });
});

// ---------------------------------------------------------------------------
// AC 5 — Non-publishDiagnostics notifications bypass debounce
// ---------------------------------------------------------------------------
describe("AC 5: non-publishDiagnostics notifications are not debounced", () => {
  const NOTIFICATION_CASES: Array<{
    label: string;
    method: string;
    params: unknown;
    eventType: string;
  }> = [
    {
      label: "window/logMessage",
      method: "window/logMessage",
      params: { type: 3, message: "log message" },
      eventType: "serverEvent",
    },
    {
      label: "window/showMessage",
      method: "window/showMessage",
      params: { type: 2, message: "show message" },
      eventType: "serverEvent",
    },
    {
      label: "$/progress",
      method: "$/progress",
      params: { token: "tok-1", value: { kind: "begin", title: "indexing" } },
      eventType: "serverEvent",
    },
  ];

  for (const { label, method, params, eventType } of NOTIFICATION_CASES) {
    test(`${label} emits immediately as serverEvent (no timer delay)`, async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(60_000_000));

      const channel = new MinimalChannel();
      const host = startAgentLspHost({ getAgentChannel: async () => channel });
      const serverEvents: unknown[] = [];
      const diagnosticsEmitted: unknown[] = [];
      host.on(eventType, (args) => serverEvents.push(args));
      host.on("diagnostics", (args) => diagnosticsEmitted.push(args));

      const URI = `file:///tmp/ws/non-diag-${label.replace(/\//g, "-")}.py`;
      await openUri(host, URI);

      // Emit the non-diagnostics notification — must reach the host immediately.
      channel.emitServerNotification(method, params);

      // No timer advance needed.
      expect(serverEvents).toHaveLength(1);
      expect((serverEvents[0] as { method: string }).method).toBe(method);

      // Diagnostics map must be untouched.
      expect(diagnosticsEmitted).toHaveLength(0);

      // Advance timers to confirm no ghost fire.
      jest.advanceTimersByTime(500);
      expect(serverEvents).toHaveLength(1);

      host.dispose();
    });
  }

  test("interleaving publishDiagnostics and window/logMessage: logMessage always immediate", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(61_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const serverEvents: unknown[] = [];
    const diagnosticsEmitted: unknown[] = [];
    host.on("serverEvent", (args) => serverEvents.push(args));
    host.on("diagnostics", (args) => diagnosticsEmitted.push(args));

    const URI = "file:///tmp/ws/interleave.py";
    await openUri(host, URI);

    // Leading-edge diagnostic emit.
    channel.emitDiagnostics(URI, 1);
    expect(diagnosticsEmitted).toHaveLength(1);

    // Schedule trailing-edge timer.
    jest.setSystemTime(new Date(61_000_000 + 50));
    channel.emitDiagnostics(URI, 2);
    expect(diagnosticsEmitted).toHaveLength(1);

    // logMessage mid-burst must be emitted immediately, no timer influence.
    channel.emitServerNotification("window/logMessage", { type: 3, message: "compiling" });
    expect(serverEvents).toHaveLength(1);
    expect(diagnosticsEmitted).toHaveLength(1); // still 1 — not affected

    // Fire trailing-edge diagnostic timer.
    jest.advanceTimersByTime(110);
    expect(diagnosticsEmitted).toHaveLength(2);
    expect(serverEvents).toHaveLength(1); // logMessage still just 1

    host.dispose();
  });

  test("window/showMessageRequest (server-request path) emits immediately as serverEvent", async () => {
    // window/showMessageRequest travels via lsp.serverRequest, not lsp.message,
    // so it has a different code path. Verify it is also not delayed.
    jest.useFakeTimers();
    jest.setSystemTime(new Date(62_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const serverEvents: unknown[] = [];
    host.on("serverEvent", (args) => serverEvents.push(args));

    const URI = "file:///tmp/ws/show-msg-req.py";
    await openUri(host, URI);

    // Emit via the server-request channel.
    channel.emit("lsp.serverRequest", {
      serverId: channel.serverId,
      agentRequestId: "smr-1",
      method: "window/showMessageRequest",
      params: { type: 1, message: "Error occurred", actions: [{ title: "Retry" }] },
    });

    // Must be immediate.
    expect(serverEvents).toHaveLength(1);
    expect((serverEvents[0] as { method: string }).method).toBe("window/showMessageRequest");

    jest.advanceTimersByTime(500);
    expect(serverEvents).toHaveLength(1);

    host.dispose();
  });
});

// ---------------------------------------------------------------------------
// Edge case: boundary at exactly DIAGNOSTICS_LEADING_IDLE_MS
// ---------------------------------------------------------------------------
describe("Leading-edge boundary conditions", () => {
  test("notification at exactly 500ms after last emit does NOT trigger leading-edge (uses trailing)", async () => {
    // The condition is: lastEmittedAt + 500 < now
    // At exactly now = lastEmittedAt + 500, the condition is FALSE → trailing-edge.
    jest.useFakeTimers();
    jest.setSystemTime(new Date(70_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI = "file:///tmp/ws/boundary-exact.py";
    await openUri(host, URI);

    // Leading-edge at T=0.
    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    // Advance to exactly T+500 (boundary is NOT crossed — lastEmittedAt + 500 === now).
    jest.setSystemTime(new Date(70_000_000 + 500));
    channel.emitDiagnostics(URI, 2);

    // At exactly 500ms, the condition `lastEmittedAt + 500 < now` is false
    // (500 < 500 is false), so this goes to trailing-edge. No immediate emit.
    expect(emitted).toHaveLength(1);

    jest.advanceTimersByTime(110);
    expect(emitted).toHaveLength(2);

    host.dispose();
  });

  test("notification at 501ms after last emit triggers leading-edge", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(71_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI = "file:///tmp/ws/boundary-501.py";
    await openUri(host, URI);

    // Leading-edge at T=0.
    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    // Advance to T+501 (just past the idle boundary).
    jest.setSystemTime(new Date(71_000_000 + 501));
    channel.emitDiagnostics(URI, 2);

    // Must be leading-edge: immediate.
    expect(emitted).toHaveLength(2);

    jest.advanceTimersByTime(200);
    expect(emitted).toHaveLength(2);

    host.dispose();
  });
});

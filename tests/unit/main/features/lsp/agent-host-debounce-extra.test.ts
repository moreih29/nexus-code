import { afterEach, describe, expect, jest, test } from "bun:test";
import { startAgentLspHost } from "../../../../../src/main/features/lsp/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../../src/main/infra/agent/channel";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

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

afterEach(() => {
  jest.useRealTimers();
});

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

    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    jest.setSystemTime(new Date(10_000_000 + 50));
    channel.emitDiagnostics(URI, 2);
    expect(emitted).toHaveLength(1);

    await host.call("didClose", { workspaceId: WORKSPACE_ID, uri: URI });

    expect(emitted).toHaveLength(2);
    expect((emitted[1] as { diagnostics: Array<{ message: string }> }).diagnostics[0].message).toBe(
      "v2",
    );

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

    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    jest.setSystemTime(new Date(11_000_000 + 50));
    channel.emitDiagnostics(URI, 99);
    expect(emitted).toHaveLength(1);

    await host.call("didClose", { workspaceId: WORKSPACE_ID, uri: URI });
    expect(emitted).toHaveLength(2);

    await openUri(host, URI);

    channel.emitDiagnostics(URI, 3);
    expect(emitted).toHaveLength(3);
    expect((emitted[2] as { diagnostics: Array<{ message: string }> }).diagnostics[0].message).toBe(
      "v3",
    );

    jest.advanceTimersByTime(200);
    expect(emitted).toHaveLength(3);

    host.dispose();
  });
});

describe("AC 2b: handleServerExited deeper coverage", () => {
  test("URIs owned by a different (surviving) server are unaffected by exit of another server", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(21_000_000));

    const exitedChannel = new MinimalChannel("srv-exited");
    const survivingChannel = new MinimalChannel("srv-surviving");
    let callCount = 0;
    const manager = {
      getAgentChannel: async (_wsId: string) => {
        callCount++;
        return callCount === 1 ? exitedChannel : survivingChannel;
      },
    };

    const host = startAgentLspHost(manager);
    const emitted: unknown[] = [];
    host.on("diagnostics", (args) => emitted.push(args));

    const URI_EXIT = "file:///tmp/ws/exit-server.py";
    const URI_SURVIVE = "file:///tmp/ws/survive-server.ts";

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

    exitedChannel.emitDiagnostics(URI_EXIT, 1);
    survivingChannel.emitDiagnostics(URI_SURVIVE, 1);
    expect(emitted).toHaveLength(2);

    jest.setSystemTime(new Date(21_000_000 + 50));
    exitedChannel.emitDiagnostics(URI_EXIT, 2);
    survivingChannel.emitDiagnostics(URI_SURVIVE, 2);
    expect(emitted).toHaveLength(2);

    exitedChannel.emit("lsp.serverExited", {
      serverId: "srv-exited",
      reason: "signal: killed",
      stderrTail: "",
    });

    jest.advanceTimersByTime(200);

    const surviveEmits = (emitted as Array<{ uri: string }>).filter((e) => e.uri === URI_SURVIVE);
    const exitEmits = (emitted as Array<{ uri: string }>).filter((e) => e.uri === URI_EXIT);
    expect(exitEmits).toHaveLength(1);
    expect(surviveEmits).toHaveLength(2);

    host.dispose();
  });
});

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

    channel.emitDiagnostics(URI, 1);
    expect(emitted).toHaveLength(1);

    jest.setSystemTime(new Date(30_000_000 + 50));
    channel.emitDiagnostics(URI, 2);
    expect(emitted).toHaveLength(1);

    host.dispose();

    jest.advanceTimersByTime(500);
    expect(emitted).toHaveLength(1);
  });
});

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

      channel.emitServerNotification(method, params);

      expect(serverEvents).toHaveLength(1);
      expect((serverEvents[0] as { method: string }).method).toBe(method);

      expect(diagnosticsEmitted).toHaveLength(0);

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

    channel.emitDiagnostics(URI, 1);
    expect(diagnosticsEmitted).toHaveLength(1);

    jest.setSystemTime(new Date(61_000_000 + 50));
    channel.emitDiagnostics(URI, 2);
    expect(diagnosticsEmitted).toHaveLength(1);

    channel.emitServerNotification("window/logMessage", { type: 3, message: "compiling" });
    expect(serverEvents).toHaveLength(1);
    expect(diagnosticsEmitted).toHaveLength(1);

    jest.advanceTimersByTime(110);
    expect(diagnosticsEmitted).toHaveLength(2);
    expect(serverEvents).toHaveLength(1);

    host.dispose();
  });

  test("window/showMessageRequest (server-request path) emits immediately as serverEvent", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(62_000_000));

    const channel = new MinimalChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const serverEvents: unknown[] = [];
    host.on("serverEvent", (args) => serverEvents.push(args));

    const URI = "file:///tmp/ws/show-msg-req.py";
    await openUri(host, URI);

    channel.emit("lsp.serverRequest", {
      serverId: channel.serverId,
      agentRequestId: "smr-1",
      method: "window/showMessageRequest",
      params: { type: 1, message: "Error occurred", actions: [{ title: "Retry" }] },
    });

    expect(serverEvents).toHaveLength(1);
    expect((serverEvents[0] as { method: string }).method).toBe("window/showMessageRequest");

    jest.advanceTimersByTime(500);
    expect(serverEvents).toHaveLength(1);

    host.dispose();
  });
});

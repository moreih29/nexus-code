/**
 * agent-host-lifecycle-degraded.test.ts
 *
 * Regression for the v0.6.0 LSP lifecycle bug: 56e411a added the `degraded`
 * / `degraded-recovered` / `ready` lifecycle events, but the LSP host's
 * lifecycle subscription only special-cased `reconnecting` and disposed every
 * server record for anything else. One spuriously late heartbeat (degraded
 * threshold = a single 5s interval) then silently killed every language
 * server on the channel.
 *
 * Observable: diagnostics routing. While server records are intact, an
 * `lsp.message` publishDiagnostics from the agent reaches the host's
 * "diagnostics" listeners; after disposeChannelServers the serverId is
 * unknown and the message is dropped.
 */

import { afterEach, describe, expect, jest, test } from "bun:test";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";
import { startAgentLspHost } from "../../../../src/main/features/lsp/agent-host";

const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";

class LifecycleTestChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();

  constructor(public readonly serverId = "srv-lifecycle-degraded") {}

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

  emitLifecycle(event: Parameters<ChannelLifecycleCallback>[0]): void {
    for (const listener of this.lifecycleListeners) {
      listener(event);
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

  dispose(): void {}
}

afterEach(() => {
  jest.useRealTimers();
});

/** Boots a host with one spawned server and a diagnostics counter. */
async function bootHostWithServer() {
  const channel = new LifecycleTestChannel();
  const host = startAgentLspHost({ getAgentChannel: async () => channel });
  const emitted: unknown[] = [];
  host.on("diagnostics", (args) => emitted.push(args));

  const uri = "file:///tmp/ws/lifecycle-degraded.py";
  await host.call("didOpen", {
    workspaceId: WORKSPACE_ID,
    workspaceRoot: "/tmp/ws",
    uri,
    languageId: "python",
    version: 1,
    text: "x = 1\n",
  });

  return { channel, host, emitted, uri };
}

/** Steps fake time past the diagnostics debounce so each emit is leading-edge. */
function stepPastDebounce(base: number, step: number): number {
  const next = base + 5_000 * step;
  jest.setSystemTime(new Date(next));
  jest.advanceTimersByTime(5_000);
  return next;
}

describe("LSP lifecycle: health signals must not dispose server records", () => {
  test("degraded / degraded-recovered / ready keep diagnostics routing alive", async () => {
    jest.useFakeTimers();
    const base = 90_000_000;
    jest.setSystemTime(new Date(base));

    const { channel, host, emitted, uri } = await bootHostWithServer();

    channel.emitDiagnostics(uri, 1);
    expect(emitted).toHaveLength(1);

    stepPastDebounce(base, 1);
    channel.emitLifecycle({ type: "degraded" });
    channel.emitDiagnostics(uri, 2);
    expect(emitted).toHaveLength(2);

    stepPastDebounce(base, 2);
    channel.emitLifecycle({ type: "degraded-recovered" });
    channel.emitDiagnostics(uri, 3);
    expect(emitted).toHaveLength(3);

    stepPastDebounce(base, 3);
    channel.emitLifecycle({ type: "ready" });
    channel.emitDiagnostics(uri, 4);
    expect(emitted).toHaveLength(4);

    host.dispose();
  });

  test("exit still disposes server records (diagnostics stop routing)", async () => {
    jest.useFakeTimers();
    const base = 90_000_000;
    jest.setSystemTime(new Date(base));

    const { channel, host, emitted, uri } = await bootHostWithServer();

    channel.emitDiagnostics(uri, 1);
    expect(emitted).toHaveLength(1);

    stepPastDebounce(base, 1);
    channel.emitLifecycle({ type: "exit", code: 1, signal: null });
    channel.emitDiagnostics(uri, 2);
    expect(emitted).toHaveLength(1);

    host.dispose();
  });

  test("held-then-expired disposes server records (daemon replaced)", async () => {
    jest.useFakeTimers();
    const base = 90_000_000;
    jest.setSystemTime(new Date(base));

    const { channel, host, emitted, uri } = await bootHostWithServer();

    channel.emitDiagnostics(uri, 1);
    expect(emitted).toHaveLength(1);

    stepPastDebounce(base, 1);
    channel.emitLifecycle({ type: "held-then-expired", previousEpoch: 1, newEpoch: 2 });
    channel.emitDiagnostics(uri, 2);
    expect(emitted).toHaveLength(1);

    host.dispose();
  });
});

/**
 * The status, log and memory the LSP host keeps of each server, and what it
 * does when one crashes: start it again, until it crashed too often.
 */

import { describe, expect, test } from "bun:test";
import { startAgentLspHost } from "../../../../src/main/features/lsp/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";
import type { LspServerStatus } from "../../../../src/shared/lsp/status";

const WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const URI = "file:///tmp/ws/main.py";

class StatusChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  spawns = 0;
  spawnError: Error | null = null;
  /** The failing spawn started a server first, as one that dies starting did. */
  assignBeforeError = false;
  serverId = "srv-0";
  private readonly listeners = new Map<string, Set<ChannelEventCallback>>();

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (method === "lsp.spawn") {
      this.spawns += 1;
      const { correlationId } = params as { correlationId: string };
      if (this.spawnError) {
        if (this.assignBeforeError) {
          this.emit("lsp.serverAssigned", { serverId: `srv-${this.spawns}`, correlationId });
        }
        throw this.spawnError;
      }
      this.serverId = `srv-${this.spawns}`;
      this.emit("lsp.serverAssigned", { serverId: this.serverId, correlationId });
      return {
        serverId: this.serverId,
        capabilities: { textDocumentSync: { openClose: true, change: 2 } },
        serverInfo: { name: "pyright", version: "1.1.400" },
      } as TResult;
    }
    if (method === "lsp.stats") {
      return { servers: [{ serverId: this.serverId, rssBytes: 123_000_000 }] } as TResult;
    }
    return {} as TResult;
  }

  fire(_method: string, _params?: unknown): void {}

  on(event: string, callback: ChannelEventCallback): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(callback);
    return () => listeners?.delete(callback);
  }

  onLifecycle(_callback: ChannelLifecycleCallback): () => void {
    return () => {};
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  dispose(): void {}
}

function boot() {
  const channel = new StatusChannel();
  const host = startAgentLspHost({ getAgentChannel: async () => channel });
  const statuses: LspServerStatus[] = [];
  host.on("serverStatus", (status) => statuses.push(status as LspServerStatus));
  const resets: Array<Record<string, unknown>> = [];
  host.on("workspaceLspReset", (args) => resets.push(args as Record<string, unknown>));
  const open = () =>
    host
      .call("didOpen", {
        workspaceId: WORKSPACE_ID,
        workspaceRoot: "/tmp/ws",
        uri: URI,
        languageId: "python",
        version: 1,
        text: "x = 1\n",
      })
      .catch(() => null);
  return { channel, host, statuses, resets, open };
}

describe("LSP server status", () => {
  test("reports a server starting, then running with the name it gave", async () => {
    const { host, statuses, open } = boot();

    await open();

    expect(statuses.map((s) => s.state)).toEqual(["starting", "running"]);
    expect(host.serverStatuses()).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        languageId: "python",
        state: "running",
        serverName: "pyright",
        serverVersion: "1.1.400",
      },
    ]);
  });

  test("an idle exit stops the server without reopening its documents", async () => {
    const { channel, host, resets, open } = boot();
    await open();

    channel.emit("lsp.serverExited", { serverId: channel.serverId, shutdown: true });

    expect(host.serverStatuses()[0]).toMatchObject({ state: "stopped", stopReason: "idle" });
    expect(resets.at(-1)?.reopen).toBeUndefined();
  });

  test("a crash starts the server again, until it crashed three times in a row", async () => {
    const { channel, host, resets, open } = boot();

    for (let crash = 1; crash <= 2; crash++) {
      await open();
      channel.emit("lsp.serverExited", {
        serverId: channel.serverId,
        reason: "exit status 1",
        stderrTail: "Traceback: boom\n",
      });
      expect(resets.at(-1)).toMatchObject({ reopen: true });
      expect(host.serverStatuses()[0]).toMatchObject({
        state: "stopped",
        stopReason: "crashed",
        error: "Exited unexpectedly: exit status 1",
      });
    }

    await open();
    channel.emit("lsp.serverExited", { serverId: channel.serverId, reason: "exit status 1" });
    expect(resets.at(-1)?.reopen).toBeUndefined();
    expect(host.serverStatuses()[0]).toMatchObject({ state: "failed", gaveUp: true });

    // It stays down until the user restarts it.
    await open();
    expect(channel.spawns).toBe(3);
    host.restartLanguage(WORKSPACE_ID, "python");
    expect(resets.at(-1)).toMatchObject({ languageId: "python", reopen: true });
    await open();
    expect(channel.spawns).toBe(4);

    const log = host.serverLog(WORKSPACE_ID, "python").map((e) => `${e.level}: ${e.message}`);
    expect(log).toContain("stderr: Traceback: boom\n");
    expect(log).toContain("error: Exited unexpectedly: exit status 1");
  });

  test("a server that fails to start is tried again, then given up on", async () => {
    const { channel, host, resets, open } = boot();
    channel.spawnError = new Error("spawn gopls: executable file not found");

    await open();
    expect(resets.at(-1)).toMatchObject({ reopen: true });
    await open();
    await open();
    expect(host.serverStatuses()[0]).toMatchObject({
      state: "failed",
      gaveUp: true,
      error: "Failed to start: spawn gopls: executable file not found",
    });
    await open();
    expect(channel.spawns).toBe(3);
  });

  test("keeps what a server that died starting printed", async () => {
    const { channel, host, open } = boot();
    channel.spawnError = new Error("lsp server exited: exit status 1");
    channel.assignBeforeError = true;

    await open();
    // Its exit comes after lsp.spawn failed, with the stderr that says why.
    channel.emit("lsp.serverExited", {
      serverId: "srv-1",
      reason: "exit status 1",
      stderrTail: "error: Unknown binary 'rust-analyzer.exe'\n",
    });

    const log = host.serverLog(WORKSPACE_ID, "python").map((e) => `${e.level}: ${e.message}`);
    expect(log).toContain("error: Failed to start: lsp server exited: exit status 1");
    expect(log).toContain("stderr: error: Unknown binary 'rust-analyzer.exe'\n");
  });

  test("turning a language off lets one that gave up start again", async () => {
    const { channel, host, open } = boot();
    channel.spawnError = new Error("no");
    for (let i = 0; i < 3; i++) await open();
    channel.spawnError = null;

    host.disposeServers(() => true, "off");
    await open();

    expect(channel.spawns).toBe(4);
    expect(host.serverStatuses()[0]?.state).toBe("running");
  });

  test("keeps what the server logs and reports its memory", async () => {
    const { channel, host, open } = boot();
    await open();

    channel.emit("lsp.message", {
      serverId: channel.serverId,
      message: { jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "hi" } },
    });

    const entries = host.serverLog(WORKSPACE_ID, "python");
    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ["lifecycle", "Started pyright 1.1.400"],
      ["info", "hi"],
    ]);
    expect(host.serverLog(WORKSPACE_ID, "python", entries[0]?.seq)).toHaveLength(1);
    expect(await host.serverMemory(WORKSPACE_ID)).toEqual([
      { languageId: "python", rssBytes: 123_000_000 },
    ]);
  });
});

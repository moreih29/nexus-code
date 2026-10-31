/**
 * Servers the app does not bundle, gopls and rust-analyzer: the host asks
 * the workspace's agent to find them, where the user said or on its host's
 * PATH, and gives up at once on one that is not installed.
 */

import { describe, expect, test } from "bun:test";
import { startAgentLspHost } from "../../../../src/main/features/lsp/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";
import type { LspServerStatus } from "../../../../src/shared/lsp/status";

const WORKSPACE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const URI = "file:///tmp/ws/main.go";

class FindingChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly calls: Array<{ method: string; params: unknown }> = [];
  found: { path: string; envPath?: string } = {
    path: "/home/u/go/bin/gopls",
    envPath: "/home/u/go/bin:/usr/bin",
  };
  serverInfo: unknown;
  private readonly listeners = new Map<string, Set<ChannelEventCallback>>();

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    this.calls.push({ method, params });
    if (method === "lsp.findBinary") return this.found as TResult;
    if (method === "lsp.spawn") {
      const { correlationId } = params as { correlationId: string };
      this.emit("lsp.serverAssigned", { serverId: "srv-1", correlationId });
      return {
        serverId: "srv-1",
        capabilities: { textDocumentSync: { openClose: true, change: 2 } },
        serverInfo: this.serverInfo,
      } as TResult;
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

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

function boot(serverPath?: string) {
  const channel = new FindingChannel();
  let remoteAsked = false;
  const host = startAgentLspHost(
    {
      getAgentChannel: async () => channel,
      ensureRemoteLspServer: async () => {
        remoteAsked = true;
        return null;
      },
    },
    { serverPath: () => serverPath },
  );
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
        languageId: "go",
        version: 1,
        text: "package main\n",
      })
      .catch(() => null);
  return { channel, host, statuses, resets, open, remoteAsked: () => remoteAsked };
}

describe("system language servers", () => {
  test("start from where the agent found them, with its PATH", async () => {
    const { channel, open, remoteAsked } = boot("~/bin/gopls");

    await open();

    expect(channel.calls[0]).toEqual({
      method: "lsp.findBinary",
      params: { name: "gopls", path: "~/bin/gopls" },
    });
    expect(channel.calls.find((c) => c.method === "lsp.spawn")?.params).toMatchObject({
      languageId: "go",
      binaryPath: "/home/u/go/bin/gopls",
      args: [],
      env: { PATH: "/home/u/go/bin:/usr/bin" },
    });
    // Nothing to upload to a remote host: the user installed it there.
    expect(remoteAsked()).toBe(false);
  });

  test("show gopls's version, not the build info it reports as one", async () => {
    const { channel, host, open } = boot();
    channel.serverInfo = {
      name: "gopls",
      version: JSON.stringify({
        GoVersion: "go1.25.8",
        Main: { Version: "v0.21.1" },
        Version: "v0.21.1",
      }),
    };

    await open();

    expect(host.serverStatuses()[0]).toMatchObject({
      serverName: "gopls",
      serverVersion: "v0.21.1",
    });
  });

  test("leave out the path when the user gave none", async () => {
    const { channel, open } = boot();

    await open();

    expect(channel.calls[0]?.params).toEqual({ name: "gopls" });
  });

  test("give up at once when not installed, and say what is missing", async () => {
    const { channel, host, resets, open } = boot();
    channel.found = { path: "" };

    await open();

    expect(channel.methods()).not.toContain("lsp.spawn");
    expect(host.serverStatuses()[0]).toMatchObject({
      languageId: "go",
      state: "failed",
      gaveUp: true,
      missingBinary: "gopls",
    });
    expect(resets.some((r) => r.reopen)).toBe(false);

    // Opening another file does not look again until a restart.
    await open();
    expect(channel.methods().filter((m) => m === "lsp.findBinary")).toHaveLength(1);
  });

  test("forget the name of a server that is gone", async () => {
    const { channel, host, open } = boot();
    channel.serverInfo = { name: "gopls", version: "v0.21.1" };
    await open();

    channel.found = { path: "" };
    host.restartLanguage(WORKSPACE_ID, "go");
    await open();

    const status = host.serverStatuses()[0];
    expect(status).toMatchObject({ state: "failed", missingBinary: "gopls" });
    expect(status?.serverName).toBeUndefined();
  });

  test("a restart looks again, and starts the server once installed", async () => {
    const { channel, host, open } = boot();
    channel.found = { path: "" };
    await open();

    channel.found = { path: "/usr/local/bin/gopls" };
    host.restartLanguage(WORKSPACE_ID, "go");
    await open();

    expect(host.serverStatuses()[0]).toMatchObject({ state: "running" });
    expect(channel.calls.find((c) => c.method === "lsp.spawn")?.params).toMatchObject({
      binaryPath: "/usr/local/bin/gopls",
    });
  });
});

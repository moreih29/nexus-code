/**
 * Settings the LSP host reads at each spawn and the stops they cause: the
 * workspace cap, a language's initializationOptions, and the restart of a
 * language's servers.
 */

import { describe, expect, test } from "bun:test";
import { startAgentLspHost } from "../../../../src/main/features/lsp/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

class SpawnRecordingChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly spawns: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<ChannelEventCallback>>();
  private nextServer = 0;

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (method === "lsp.spawn") {
      const spawn = params as Record<string, unknown>;
      this.spawns.push(spawn);
      this.nextServer += 1;
      const serverId = `srv-${this.nextServer}`;
      for (const listener of this.listeners.get("lsp.serverAssigned") ?? []) {
        listener({ serverId, correlationId: spawn.correlationId });
      }
      return {
        serverId,
        capabilities: { textDocumentSync: { openClose: true, change: 2 } },
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

  dispose(): void {}
}

function open(
  host: ReturnType<typeof startAgentLspHost>,
  workspaceId: string,
  languageId: string,
  file: string,
) {
  return host.call("didOpen", {
    workspaceId,
    workspaceRoot: `/tmp/${workspaceId}`,
    uri: `file:///tmp/${workspaceId}/${file}`,
    languageId,
    version: 1,
    text: "\n",
  });
}

describe("LSP host settings", () => {
  test("starts a server with the initializationOptions the settings give", async () => {
    const channel = new SpawnRecordingChannel();
    const host = startAgentLspHost(
      { getAgentChannel: async () => channel },
      {
        initializationOptions: (languageId, preset) =>
          languageId === "typescript"
            ? { ...(preset.initializationOptions as object), lowMemory: true }
            : preset.initializationOptions,
      },
    );

    await open(host, WORKSPACE_A, "typescript", "a.ts");

    expect(channel.spawns[0]?.initializationOptions).toEqual({
      hostInfo: "nexus-code",
      preferences: {},
      lowMemory: true,
    });
  });

  test("a lowered cap stops the least recently used workspace", async () => {
    const channel = new SpawnRecordingChannel();
    let cap = 2;
    const host = startAgentLspHost(
      { getAgentChannel: async () => channel },
      { maxActiveWorkspaces: () => cap },
    );
    const resets: unknown[] = [];
    host.on("workspaceLspReset", (args) => resets.push(args));

    await open(host, WORKSPACE_A, "python", "a.py");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await open(host, WORKSPACE_B, "python", "b.py");
    expect(resets).toEqual([]);

    cap = 1;
    host.enforceMaxActiveWorkspaces();

    expect(resets).toEqual([
      expect.objectContaining({ workspaceId: WORKSPACE_A, reason: "evicted by LRU cap" }),
    ]);
  });

  test("restarting a language asks the renderer to reopen its documents", async () => {
    const channel = new SpawnRecordingChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    const resets: unknown[] = [];
    host.on("workspaceLspReset", (args) => resets.push(args));

    await open(host, WORKSPACE_A, "typescript", "a.ts");
    await open(host, WORKSPACE_A, "python", "a.py");
    await open(host, WORKSPACE_B, "typescript", "b.ts");

    host.disposeServers((_workspaceId, languageId) => languageId === "typescript", "restart", {
      reopen: true,
    });

    expect(resets).toEqual([
      {
        workspaceId: WORKSPACE_A,
        languageId: "typescript",
        reason: "restarted",
        reopen: true,
      },
      {
        workspaceId: WORKSPACE_B,
        languageId: "typescript",
        reason: "restarted",
        reopen: true,
      },
    ]);

    // The next document starts a new server.
    await open(host, WORKSPACE_A, "typescript", "a2.ts");
    expect(channel.spawns.filter((spawn) => spawn.languageId === "typescript")).toHaveLength(3);
  });
});

import { describe, expect, test } from "bun:test";
import type { AgentPtyWorkspaceManager } from "../../../../../src/main/features/pty/agent-host";
import { startAgentPtyHost } from "../../../../../src/main/features/pty/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../../src/main/infra/agent/channel";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAB_A = "11111111-1111-4111-8111-111111111111";
const TAB_B = "22222222-2222-4222-8222-222222222222";

class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly calls: Array<{ method: string; params: unknown }> = [];

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    return (method === "pty.spawn" ? { pid: 1 } : undefined) as T;
  }
  fire(_method: string, _params?: unknown): void {}
  on(_event: string, _cb: ChannelEventCallback): () => void {
    return () => {};
  }
  onLifecycle(_cb: ChannelLifecycleCallback): () => void {
    return () => {};
  }
  dispose(): void {}
}

function makeWorkspaceManager(
  workspaceId: string,
  channel: AgentChannel,
): AgentPtyWorkspaceManager {
  return {
    async getAgentChannel(id: string): Promise<AgentChannel> {
      if (id === workspaceId) return channel;
      throw new Error(`workspace not found: ${id}`);
    },
    async tryGetAgentChannel(id: string): Promise<AgentChannel | null> {
      return id === workspaceId ? channel : null;
    },
  };
}

describe("AgentPtyHostHandle.closeWorkspaceSessions", () => {
  test("emits pty.exit for every active session of the removed workspace", async () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager(WORKSPACE_ID, channel);
    const host = startAgentPtyHost(manager);

    const exits: Array<unknown> = [];
    host.on("exit", (args) => exits.push(args));

    await host.call("spawn", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_A,
      cwd: "/",
      cols: 80,
      rows: 24,
    });
    await host.call("spawn", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_B,
      cwd: "/",
      cols: 80,
      rows: 24,
    });

    host.closeWorkspaceSessions(WORKSPACE_ID);

    expect(exits).toHaveLength(2);
    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A, code: null });
    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_B, code: null });
  });

  test("closeWorkspaceSessions is idempotent — second call emits no exits", async () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager(WORKSPACE_ID, channel);
    const host = startAgentPtyHost(manager);

    const exits: Array<unknown> = [];
    host.on("exit", (args) => exits.push(args));

    await host.call("spawn", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_A,
      cwd: "/",
      cols: 80,
      rows: 24,
    });

    host.closeWorkspaceSessions(WORKSPACE_ID);
    host.closeWorkspaceSessions(WORKSPACE_ID);

    expect(exits).toHaveLength(1);
  });
});

describe("AgentPtyHostHandle.call — no-op for removed workspace", () => {
  test("write returns undefined and emits no channel call when workspace is gone", async () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager("other-workspace", channel);
    const host = startAgentPtyHost(manager);

    const result = await host.call("write", { workspaceId: WORKSPACE_ID, tabId: TAB_A, data: "x" });

    expect(result).toBeUndefined();
    expect(channel.calls).toHaveLength(0);
  });

  test("spawn still throws when workspace is gone (callers depend on the pid)", async () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager("other-workspace", channel);
    const host = startAgentPtyHost(manager);

    await expect(
      host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 }),
    ).rejects.toThrow("workspace not found");
  });
});

describe("workspace removal ordering", () => {
  test("closeWorkspaceSessions called before the manager removes the context means post-removal kill is a no-op", async () => {
    const channel = new FakeAgentChannel();
    let workspaceAvailable = true;

    const manager: AgentPtyWorkspaceManager = {
      async getAgentChannel(id: string): Promise<AgentChannel> {
        if (id === WORKSPACE_ID && workspaceAvailable) return channel;
        throw new Error(`workspace not found: ${id}`);
      },
      async tryGetAgentChannel(id: string): Promise<AgentChannel | null> {
        return id === WORKSPACE_ID && workspaceAvailable ? channel : null;
      },
    };

    const host = startAgentPtyHost(manager);
    const exits: Array<unknown> = [];
    host.on("exit", (args) => exits.push(args));

    await host.call("spawn", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_A,
      cwd: "/",
      cols: 80,
      rows: 24,
    });

    host.closeWorkspaceSessions(WORKSPACE_ID);
    expect(exits).toHaveLength(1);

    workspaceAvailable = false;

    const killResult = await host.call("kill", { workspaceId: WORKSPACE_ID, tabId: TAB_A });
    expect(killResult).toBeUndefined();

    const killCalls = channel.calls.filter((c) => c.method === "pty.kill");
    expect(killCalls).toHaveLength(0);
  });
});

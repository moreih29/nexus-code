/**
 * Tests for the workspace-removal teardown sequence introduced in T2.
 *
 * Core invariant: when a workspace is removed, `AgentPtyHostHandle.closeWorkspaceSessions`
 * must emit pty.exit for every active session *before* the workspace context is
 * deleted, so the renderer receives a well-ordered "session dead → workspace
 * removed" stream rather than discovering the death via a failed IPC round-trip.
 *
 * Secondary invariant: write/resize/ack/kill called on a workspace whose
 * channel is no longer available (post-removal renderer IPC) must silently
 * no-op rather than propagating a "workspace not found" throw.
 */
import { describe, expect, test } from "bun:test";
import { startAgentPtyHost } from "../../../../src/main/features/pty/agent-host";
import type { AgentPtyWorkspaceManager } from "../../../../src/main/features/pty/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAB_A = "11111111-1111-4111-8111-111111111111";
const TAB_B = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Minimal fake channel
// ---------------------------------------------------------------------------

class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly calls: Array<{ method: string; params: unknown }> = [];

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    return (method === "pty.spawn" ? { pid: 1 } : undefined) as T;
  }
  on(_event: string, _cb: ChannelEventCallback): () => void {
    return () => {};
  }
  onLifecycle(_cb: ChannelLifecycleCallback): () => void {
    return () => {};
  }
  dispose(): void {}
}

/**
 * Builds a workspace manager stub that returns `channel` for the given
 * `workspaceId` and `null` (missing) for any other id.
 */
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

// ---------------------------------------------------------------------------
// closeWorkspaceSessions
// ---------------------------------------------------------------------------

describe("AgentPtyHostHandle.closeWorkspaceSessions", () => {
  test("emits pty.exit for every active session of the removed workspace", async () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager(WORKSPACE_ID, channel);
    const host = startAgentPtyHost(manager);

    const exits: Array<unknown> = [];
    host.on("exit", (args) => exits.push(args));

    // Spawn two sessions.
    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_B, cwd: "/", cols: 80, rows: 24 });

    // Simulate WorkspaceManager.remove() calling closeWorkspaceSessions first.
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

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });

    host.closeWorkspaceSessions(WORKSPACE_ID);
    host.closeWorkspaceSessions(WORKSPACE_ID); // second call must be a no-op

    expect(exits).toHaveLength(1); // only one exit emitted
  });

  test("closeWorkspaceSessions on unknown workspace is a no-op", () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager(WORKSPACE_ID, channel);
    const host = startAgentPtyHost(manager);

    const exits: Array<unknown> = [];
    host.on("exit", (args) => exits.push(args));

    // Calling on a workspace that never had sessions must not throw.
    expect(() => host.closeWorkspaceSessions("unknown-workspace-id")).not.toThrow();
    expect(exits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// write/resize/ack/kill no-op when workspace is gone
// ---------------------------------------------------------------------------

describe("AgentPtyHostHandle.call — no-op for removed workspace", () => {
  test("write returns undefined and emits no channel call when workspace is gone", async () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager("other-workspace", channel);
    const host = startAgentPtyHost(manager);

    // WORKSPACE_ID is unknown to this manager — tryGetAgentChannel returns null.
    const result = await host.call("write", { workspaceId: WORKSPACE_ID, tabId: TAB_A, data: "x" });

    expect(result).toBeUndefined();
    expect(channel.calls).toHaveLength(0);
  });

  test("kill returns undefined and emits no channel call when workspace is gone", async () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager("other-workspace", channel);
    const host = startAgentPtyHost(manager);

    const result = await host.call("kill", { workspaceId: WORKSPACE_ID, tabId: TAB_A });

    expect(result).toBeUndefined();
    expect(channel.calls).toHaveLength(0);
  });

  test("resize returns undefined and emits no channel call when workspace is gone", async () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager("other-workspace", channel);
    const host = startAgentPtyHost(manager);

    const result = await host.call("resize", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_A,
      cols: 100,
      rows: 30,
    });

    expect(result).toBeUndefined();
    expect(channel.calls).toHaveLength(0);
  });

  test("ack returns undefined and emits no channel call when workspace is gone", async () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager("other-workspace", channel);
    const host = startAgentPtyHost(manager);

    const result = await host.call("ack", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_A,
      bytesConsumed: 128,
    });

    expect(result).toBeUndefined();
    expect(channel.calls).toHaveLength(0);
  });

  test("spawn still throws when workspace is gone (callers depend on the pid)", async () => {
    const channel = new FakeAgentChannel();
    const manager = makeWorkspaceManager("other-workspace", channel);
    const host = startAgentPtyHost(manager);

    // spawn uses getAgentChannel (not tryGetAgentChannel) and must propagate
    // the "workspace not found" error so callers know the spawn failed.
    await expect(
      host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 }),
    ).rejects.toThrow("workspace not found");
  });
});

// ---------------------------------------------------------------------------
// Teardown ordering: closeWorkspaceSessions before context deletion
// ---------------------------------------------------------------------------

describe("workspace removal ordering", () => {
  test("closeWorkspaceSessions called before the manager removes the context means post-removal kill is a no-op", async () => {
    // Simulate the WorkspaceManager.remove() sequence:
    //   1. ptySessionCloser(id)          ← closeWorkspaceSessions
    //   2. contexts.delete(id)           ← channel is now unavailable
    //   3. broadcast workspace:removed   ← renderer sends pty.kill
    //
    // After step 2, the manager treats the workspace as gone.
    // The pty.kill IPC that arrives from the renderer in step 3 must not throw.
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

    // Step 0 — session is live.
    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });

    // Step 1 — WorkspaceManager calls closeWorkspaceSessions before deletion.
    host.closeWorkspaceSessions(WORKSPACE_ID);
    expect(exits).toHaveLength(1); // exit already emitted

    // Step 2 — Manager deletes the context.
    workspaceAvailable = false;

    // Step 3 — Renderer sends pty.kill (fire-and-forget); must not throw.
    const killResult = await host.call("kill", { workspaceId: WORKSPACE_ID, tabId: TAB_A });
    expect(killResult).toBeUndefined(); // no-op

    // The agent channel received no kill call after the workspace was gone.
    const killCalls = channel.calls.filter((c) => c.method === "pty.kill");
    expect(killCalls).toHaveLength(0);
  });
});

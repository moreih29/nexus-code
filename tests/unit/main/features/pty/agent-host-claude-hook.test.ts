import { describe, expect, test } from "bun:test";
import { startAgentPtyHost } from "../../../../../src/main/features/pty/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../../../../../src/main/infra/agent/channel";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TAB_ID = "11111111-1111-4111-8111-111111111111";

class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  private readonly listeners = new Map<string, Set<ChannelEventCallback>>();
  private readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();

  async call<T = unknown>(method: string): Promise<T> {
    if (method === "session.list") return { sessions: [] } as T;
    return (method === "pty.spawn" ? { pid: 1 } : undefined) as T;
  }
  fire(): void {}
  on(event: string, cb: ChannelEventCallback): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => set.delete(cb);
  }
  onLifecycle(cb: ChannelLifecycleCallback): () => void {
    this.lifecycleListeners.add(cb);
    return () => this.lifecycleListeners.delete(cb);
  }
  emitLifecycle(event: ChannelLifecycleEvent): void {
    for (const cb of [...this.lifecycleListeners]) cb(event);
  }
  dispose(): void {}
  emit(event: string, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload);
  }
}

describe("AgentPtyHost claude.hook relay", () => {
  test("relays hooks for the channel's own workspace and drops others", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentPtyHost({
      async getAgentChannel() {
        return channel;
      },
      async tryGetAgentChannel() {
        return channel;
      },
    });
    const relayed: unknown[] = [];
    host.on("claude.hook", (payload) => relayed.push(payload));
    await host.call("spawn", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      cwd: "/",
      cols: 80,
      rows: 24,
    });

    const own = { hookId: "h1", workspaceId: WORKSPACE_ID, tabId: TAB_ID, subcommand: "stop" };
    const spoofed = {
      hookId: "h2",
      workspaceId: OTHER_WORKSPACE_ID,
      tabId: TAB_ID,
      subcommand: "stop",
    };
    channel.emit("claude.hook", own);
    channel.emit("claude.hook", spoofed);
    channel.emit("claude.hook", null);

    expect(relayed).toEqual([own]);
  });

  test("relays hooks once the workspace's agent is ready, before any terminal", async () => {
    const first = new FakeAgentChannel();
    const second = new FakeAgentChannel();
    let channel = first;
    let ready: ((workspaceId: string) => void) | undefined;
    const host = startAgentPtyHost({
      async getAgentChannel() {
        return channel;
      },
      async tryGetAgentChannel() {
        return channel;
      },
      onProviderReady(listener) {
        ready = listener;
        return () => {
          ready = undefined;
        };
      },
    });
    const relayed: unknown[] = [];
    host.on("claude.hook", (payload) => relayed.push(payload));
    const hook = (hookId: string) => ({
      hookId,
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      subcommand: "pre-tool-use",
    });

    ready?.(WORKSPACE_ID);
    await Bun.sleep(0);
    first.emit("claude.hook", hook("h1"));
    channel = second;
    ready?.(WORKSPACE_ID);
    await Bun.sleep(0);
    second.emit("claude.hook", hook("h2"));
    first.emit("claude.hook", hook("h3"));
    expect(relayed).toEqual([hook("h1"), hook("h2")]);

    host.dispose();
    expect(ready).toBeUndefined();
  });

  test("keeps relaying hooks and CLI requests once a local agent restarts on the same channel", async () => {
    const channel = new FakeAgentChannel();
    let ready: ((workspaceId: string) => void) | undefined;
    const host = startAgentPtyHost({
      async getAgentChannel() {
        return channel;
      },
      async tryGetAgentChannel() {
        return channel;
      },
      onProviderReady(listener) {
        ready = listener;
        return () => {
          ready = undefined;
        };
      },
    });
    const hooks: unknown[] = [];
    const gone: unknown[] = [];
    const requests: unknown[] = [];
    host.on("claude.hook", (payload) => hooks.push(payload));
    host.on("claude.hookGone", (payload) => gone.push(payload));
    host.on("cli.request", (payload) => requests.push(payload));
    ready?.(WORKSPACE_ID);
    await Bun.sleep(0);

    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: false });
    channel.emitLifecycle({ type: "ready" });
    await Bun.sleep(0);

    const start = {
      hookId: "h1",
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      subcommand: "print-start",
      payload: { run_id: "print-1" },
    };
    const watchGone = { ...start, hookId: "h2", subcommand: "print-watch" };
    const request = { requestId: "r1", workspaceId: WORKSPACE_ID, tabId: TAB_ID };
    const tell = () => {
      channel.emit("claude.hook", start);
      channel.emit("claude.hookGone", watchGone);
      channel.emit("cli.request", request);
    };
    tell();
    expect(hooks).toEqual([start]);
    expect(gone).toEqual([watchGone]);
    expect(requests).toEqual([request]);

    ready?.(WORKSPACE_ID);
    await Bun.sleep(0);
    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_ID, cols: 80, rows: 24 });
    await host.call("write", { workspaceId: WORKSPACE_ID, tabId: TAB_ID, data: "x" });
    tell();
    expect(hooks).toEqual([start, start]);
    expect(gone).toEqual([watchGone, watchGone]);
    expect(requests).toEqual([request, request]);
  });
});

describe("AgentPtyHost Claude settings in a Windows terminal", () => {
  const SETTINGS = "C:\\Users\\me\\.nexus-code\\claude-settings.json";
  const SERVERLESS = "C:\\Users\\me\\.nexus-code\\claude-settings-serverless.json";
  const SOCKET = "C:\\s\\h-1.sock";

  async function spawnedEnv(hooks: { socketPath: string; token: string } | null) {
    const channel = new FakeAgentChannel();
    const spawned: { env?: Record<string, string> }[] = [];
    const call = channel.call.bind(channel);
    channel.call = (async (method: string, params?: unknown) => {
      if (method === "pty.spawn") spawned.push(params as { env?: Record<string, string> });
      return call(method);
    }) as typeof channel.call;
    const host = startAgentPtyHost({
      async getAgentChannel() {
        return channel;
      },
      async tryGetAgentChannel() {
        return channel;
      },
      async getSpawnHookInfo() {
        return hooks;
      },
    });
    await host.call("spawn", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      cwd: "C:\\",
      cols: 80,
      rows: 24,
      env: {
        NEXUS_WRAPPER_SELF_DIR: "C:\\Users\\me\\.nexus-code\\cli",
        NEXUS_CLAUDE_SETTINGS: SETTINGS,
        NEXUS_CLAUDE_SERVERLESS_SETTINGS: SERVERLESS,
      },
    });
    host.dispose();
    return spawned[0]?.env ?? {};
  }

  test("keeps every hook while the hook server runs", async () => {
    const env = await spawnedEnv({ socketPath: SOCKET, token: "tok" });
    expect(env.NEXUS_CLAUDE_SETTINGS).toBe(SETTINGS);
    expect(env.NEXUS_AGENT_SOCKET).toBe(SOCKET);
    expect(env.NEXUS_CLAUDE_SERVERLESS_SETTINGS).toBeUndefined();
  });

  test("switches to the hooks that run without the server when it is not there", async () => {
    const env = await spawnedEnv(null);
    expect(env.NEXUS_CLAUDE_SETTINGS).toBe(SERVERLESS);
    expect(env.NEXUS_AGENT_SOCKET).toBeUndefined();
    expect(env.NEXUS_HOOK_TOKEN).toBeUndefined();
    expect(env.NEXUS_CLAUDE_SERVERLESS_SETTINGS).toBeUndefined();
  });
});

/**
 * claude.hook events are relayed only for the workspace whose agent channel
 * they arrived on. Regression: the payload's own workspaceId was trusted, so
 * anything reaching an SSH host's hook server could drive another
 * workspace's Claude status and notifications.
 */
import { describe, expect, test } from "bun:test";
import { startAgentPtyHost } from "../../../../src/main/features/pty/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TAB_ID = "11111111-1111-4111-8111-111111111111";

class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  private readonly listeners = new Map<string, Set<ChannelEventCallback>>();

  async call<T = unknown>(method: string): Promise<T> {
    return (method === "pty.spawn" ? { pid: 1 } : undefined) as T;
  }
  fire(): void {}
  on(event: string, cb: ChannelEventCallback): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => set.delete(cb);
  }
  onLifecycle(_cb: ChannelLifecycleCallback): () => void {
    return () => {};
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

  // Regression: a channel was subscribed only at a PTY call, so the hooks of
  // a workspace whose terminals had not run yet (a Claude tab's, or any
  // after a reconnect to a new agent) went unanswered until they timed out.
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
    // A new agent after a reconnect.
    channel = second;
    ready?.(WORKSPACE_ID);
    await Bun.sleep(0);
    second.emit("claude.hook", hook("h2"));
    first.emit("claude.hook", hook("h3"));
    expect(relayed).toEqual([hook("h1"), hook("h2")]);

    host.dispose();
    expect(ready).toBeUndefined();
  });
});

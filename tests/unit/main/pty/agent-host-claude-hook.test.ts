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
});

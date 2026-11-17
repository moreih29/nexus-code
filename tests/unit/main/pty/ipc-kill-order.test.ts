/**
 * ipc-kill-order.test.ts — a terminal closed while main still prepares its
 * spawn (a profile's environment, the workspace's agent) is killed after
 * that spawn, not before: sent first, the kill finds no session, and the
 * shell then starts with no tab to close it.
 */

import { describe, expect, mock, test } from "bun:test";
import type { PtyChannelOptions } from "../../../../src/main/features/pty/ipc";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";

const mockHandle = mock((_channel: string, _handler: unknown) => {});

mock.module("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: mockHandle, on: mock(() => {}) },
  webContents: { getAllWebContents: () => [] },
}));

const { setupRouter } = await import("../../../../src/main/infra/ipc-router");
const { startAgentPtyHost } = await import("../../../../src/main/features/pty/agent-host");
const { registerPtyChannel } = await import("../../../../src/main/features/pty/ipc");

setupRouter();

const WORKSPACE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TAB_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

type IpcHandler = (
  event: { sender?: { id?: number } },
  channelName: string,
  method: string,
  args: unknown,
) => Promise<unknown>;

class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly order: string[] = [];
  readonly sessions = new Set<string>();

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    const tabId = (params as { tabId?: string } | undefined)?.tabId ?? "";
    if (method === "pty.spawn") {
      this.order.push("pty.spawn");
      this.sessions.add(tabId);
      return { pid: 7 } as TResult;
    }
    if (method === "pty.kill") {
      this.order.push("pty.kill");
      this.sessions.delete(tabId);
    }
    return {} as TResult;
  }
  fire(): void {}
  on(_event: string, _callback: ChannelEventCallback): () => void {
    return () => {};
  }
  onLifecycle(_callback: ChannelLifecycleCallback): () => void {
    return () => {};
  }
  dispose(): void {}
}

function setup(profileEnv: PtyChannelOptions["profileEnv"]) {
  const agent = new FakeAgentChannel();
  const agentHost = startAgentPtyHost({
    getAgentChannel: async () => agent,
    tryGetAgentChannel: async () => agent,
  });
  registerPtyChannel({ agentHost, profileEnv });
  const calls = mockHandle.mock.calls as [string, IpcHandler][];
  const handler = calls.filter(([channel]) => channel === "ipc:call").at(-1)?.[1];
  if (!handler) throw new Error("ipc:call was not registered");
  return { call: (method: string, args: unknown) => handler({}, "pty", method, args), agent };
}

describe("pty.kill — a terminal closed while its spawn is prepared", () => {
  test("is killed after its spawn reaches the agent, so no shell is left without a tab", async () => {
    let giveEnv: (env: Record<string, string>) => void = () => {};
    const { call, agent } = setup(
      () =>
        new Promise((resolve) => {
          giveEnv = resolve;
        }),
    );

    const spawning = call("spawn", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
      profile: "codex-work",
    });
    await new Promise((r) => setTimeout(r, 0));
    const killing = call("kill", { workspaceId: WORKSPACE_ID, tabId: TAB_ID });
    await new Promise((r) => setTimeout(r, 0));
    giveEnv({ CODEX_HOME: "/home/u/.codex-work" });
    await spawning;
    await killing;

    expect(agent.order).toEqual(["pty.spawn", "pty.kill"]);
    expect(agent.sessions.size).toBe(0);
  });

  test("is still killed when its spawn fails", async () => {
    let failEnv: () => void = () => {};
    const { call, agent } = setup(
      () =>
        new Promise((resolve) => {
          failEnv = () => resolve(null);
        }),
    );

    const spawning = call("spawn", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
      profile: "gone",
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    const killing = call("kill", { workspaceId: WORKSPACE_ID, tabId: TAB_ID });
    failEnv();
    await spawning;
    await killing;

    expect(agent.order).toEqual(["pty.kill"]);
  });
});

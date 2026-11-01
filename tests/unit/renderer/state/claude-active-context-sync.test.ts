/**
 * Switching tabs records when the user had each terminal in front of them:
 * the one they leave until now, the one they go to from now. The inbox reads
 * a done session as looked at from these times.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const ipcCalls: Array<{ channel: string; method: string; args: unknown }> = [];

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    return Promise.resolve({ ok: true as const, value: undefined });
  },
}));

const { startClaudeActiveContextSync } = await import(
  "../../../../src/renderer/state/claude-active-context-sync"
);
const { useActiveStore } = await import("../../../../src/renderer/state/stores/active");
const { useLayoutStore } = await import("../../../../src/renderer/state/stores/layout/store");
const { useSessionSeenStore } = await import("../../../../src/renderer/state/stores/session-seen");

const WS = "00000000-0000-4000-8000-000000000001";

function showTab(tabId: string): void {
  useLayoutStore.setState({
    byWorkspace: {
      [WS]: {
        root: { kind: "leaf", id: "g1", tabIds: ["t1", "t2"], activeTabId: tabId },
        activeGroupId: "g1",
      },
    },
  } as Partial<ReturnType<typeof useLayoutStore.getState>>);
}

describe("claude active context sync", () => {
  let stop: () => void = () => {};
  let clock = 1_000;
  const realNow = Date.now;

  beforeEach(() => {
    ipcCalls.length = 0;
    clock = 1_000;
    Date.now = () => clock;
    useSessionSeenStore.setState({ byWorkspace: {} });
    useActiveStore.getState().setActiveWorkspaceId(WS);
    showTab("t1");
    stop = startClaudeActiveContextSync();
  });

  afterEach(() => {
    stop();
    Date.now = realNow;
  });

  it("marks the tab shown at start as seen", () => {
    expect(useSessionSeenStore.getState().byWorkspace[WS]).toEqual({ t1: 1_000 });
  });

  it("marks the tab left and the tab shown when the user switches", () => {
    clock = 5_000;
    showTab("t2");
    expect(useSessionSeenStore.getState().byWorkspace[WS]).toEqual({ t1: 5_000, t2: 5_000 });
  });

  it("still tells main, which clears Claude's completed state", () => {
    showTab("t2");
    expect(ipcCalls).toContainEqual({
      channel: "claude",
      method: "markSeen",
      args: { workspaceId: WS, tabId: "t2" },
    });
  });
});

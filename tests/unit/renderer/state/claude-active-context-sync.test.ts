/**
 * Switching tabs records when the user had each terminal in front of them:
 * the one they leave until now, the one they go to from now. The inbox reads
 * a done session as looked at from these times. Going to another app and
 * back counts the same: the active terminal is in front of the user only
 * while the window has focus.
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
const { useAppFocusStore } = await import("../../../../src/renderer/state/stores/app-focus");
const { viewingKey } = await import("../../../../src/renderer/services/sessions/viewing");
const { useLayoutStore } = await import("../../../../src/renderer/state/stores/layout/store");
const { useSessionSeenStore } = await import("../../../../src/renderer/state/stores/session-seen");
const { __resetAgentViewForTests, useAgentViewStore } = await import(
  "../../../../src/renderer/state/stores/agent-view"
);

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
    useAppFocusStore.setState({ focused: true });
    useActiveStore.getState().setActiveWorkspaceId(WS);
    showTab("t1");
    stop = startClaudeActiveContextSync();
  });

  afterEach(() => {
    stop();
    Date.now = realNow;
    __resetAgentViewForTests();
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

  it("marks the active tab when the user leaves the app and when they come back", () => {
    clock = 5_000;
    useAppFocusStore.setState({ focused: false });
    expect(useSessionSeenStore.getState().byWorkspace[WS]).toEqual({ t1: 5_000 });
    ipcCalls.length = 0;
    clock = 9_000;
    useAppFocusStore.setState({ focused: true });
    expect(useSessionSeenStore.getState().byWorkspace[WS]).toEqual({ t1: 9_000 });
    // Claude's completed state, set while the user was away, clears too.
    expect(ipcCalls).toContainEqual({
      channel: "claude",
      method: "markSeen",
      args: { workspaceId: WS, tabId: "t1" },
    });
  });

  it("doesn't count a tab shown while the user is in another app as looked at", () => {
    clock = 5_000;
    useAppFocusStore.setState({ focused: false });
    ipcCalls.length = 0;
    clock = 6_000;
    showTab("t2");
    expect(useSessionSeenStore.getState().byWorkspace[WS]).toEqual({ t1: 5_000 });
    expect(ipcCalls.some((call) => call.method === "markSeen")).toBe(false);
    clock = 9_000;
    useAppFocusStore.setState({ focused: true });
    expect(useSessionSeenStore.getState().byWorkspace[WS]).toEqual({ t1: 5_000, t2: 9_000 });
  });

  it("has the inbox see the active terminal only while the window has focus", () => {
    expect(viewingKey()).toBe(`${WS}:t1`);
    useAppFocusStore.setState({ focused: false });
    expect(viewingKey()).toBeNull();
  });

  it("in the agent view, counts the active panel's front agent as in front of the user", () => {
    clock = 5_000;
    useAgentViewStore.setState({
      mode: "agents",
      root: { kind: "leaf", id: "p1", tabIds: [`${WS}:t2`], activeTabId: `${WS}:t2` },
      activeLeafId: "p1",
    });
    expect(useSessionSeenStore.getState().byWorkspace[WS]).toEqual({ t1: 5_000, t2: 5_000 });
    expect(viewingKey()).toBe(`${WS}:t2`);
  });

  it("in the agent view with no agent in front, counts none as in front of the user", () => {
    useAgentViewStore.setState({
      mode: "agents",
      root: { kind: "leaf", id: "p1", tabIds: [], activeTabId: null },
      activeLeafId: "p1",
    });
    expect(viewingKey()).toBeNull();
  });
});

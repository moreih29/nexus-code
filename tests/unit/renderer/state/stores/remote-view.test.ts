/**
 * Another computer's sessions as tabs of the agent view: opened into the
 * active panel (or brought to the front of the one holding them), kept by
 * key with the names the tab shows, and renamed as their computer's list
 * says; the panels keep them as this computer's tabs close.
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: () => Promise.resolve({ ok: true as const, value: undefined }),
}));

const { __resetAgentViewForTests, useAgentViewStore } = await import(
  "../../../../../src/renderer/state/stores/agent-view"
);
const { useRemoteViewStore } = await import("../../../../../src/renderer/state/stores/remote-view");
const { Grid } = await import("../../../../../src/renderer/engine");
const { remoteSessionKey } = await import("../../../../../src/renderer/services/agent-view/layout");
const { staysInPanels } = await import("../../../../../src/renderer/services/agent-view/show");

const target = {
  deviceId: "d2",
  deviceName: "Work PC",
  workspaceId: "w1",
  workspaceName: "api",
  path: "/src/api",
  tabId: "t1",
  kind: "claude" as const,
  title: "Fix the build",
  state: "idle" as const,
};
const KEY = remoteSessionKey(target);

const tabsOf = () => Grid.allLeaves(useAgentViewStore.getState().root).map((leaf) => leaf.tabIds);

describe("remote sessions as tabs", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __resetAgentViewForTests();
    useRemoteViewStore.setState({ targets: new Map() });
  });

  afterEach(() => {
    __resetAgentViewForTests();
    jest.useRealTimers();
  });

  it("opens in the active panel, in front, with the agent view shown", () => {
    useRemoteViewStore.getState().open(target);
    const view = useAgentViewStore.getState();
    expect(view.mode).toBe("agents");
    expect(tabsOf()).toEqual([[KEY]]);
    expect(Grid.findLeaf(view.root, view.activeLeafId)?.activeTabId).toBe(KEY);
    expect(useRemoteViewStore.getState().targets.get(KEY)).toEqual(target);
  });

  it("opened again, comes to the front of its panel once", () => {
    const other = { ...target, tabId: "t2", title: "Other" };
    useRemoteViewStore.getState().open(target);
    useRemoteViewStore.getState().open(other);
    useRemoteViewStore.getState().open(target);
    const view = useAgentViewStore.getState();
    expect(tabsOf()).toEqual([[KEY, remoteSessionKey(other)]]);
    expect(Grid.findLeaf(view.root, view.activeLeafId)?.activeTabId).toBe(KEY);
  });

  it("takes up its computer's new title and state, and nothing from another", () => {
    useRemoteViewStore.getState().open(target);
    const before = useRemoteViewStore.getState().targets;
    const listed = {
      workspaces: [{ id: "w1", name: "api", path: "/src/api" }],
      sessions: [
        {
          workspaceId: "w1",
          tabId: "t1",
          kind: "claude" as const,
          title: "Fix the build",
          state: "idle" as const,
        },
      ],
    };
    useRemoteViewStore.getState().refresh("d2", listed);
    expect(useRemoteViewStore.getState().targets).toBe(before);
    useRemoteViewStore.getState().refresh("d9", {
      ...listed,
      sessions: [{ ...listed.sessions[0], title: "Elsewhere" }],
    });
    expect(useRemoteViewStore.getState().targets).toBe(before);
    useRemoteViewStore.getState().refresh("d2", {
      ...listed,
      sessions: [{ ...listed.sessions[0], title: "Fixed", state: "needs-you" as const }],
    });
    expect(useRemoteViewStore.getState().targets.get(KEY)).toMatchObject({
      title: "Fixed",
      state: "needs-you",
    });
  });

  it("a terminal takes up the request its Claude Code holds, and lets go of it once answered", () => {
    const terminal = { ...target, tabId: "t3", kind: "terminal" as const, title: "claude" };
    const key = remoteSessionKey(terminal);
    useRemoteViewStore.getState().open(terminal);
    const listed = (waiting?: {
      kind: "permission";
      text: string;
      requestId?: string;
      always?: boolean;
      subagent?: boolean;
    }) => ({
      workspaces: [{ id: "w1", name: "api", path: "/src/api" }],
      sessions: [
        {
          workspaceId: "w1",
          tabId: "t3",
          kind: "terminal" as const,
          title: "claude",
          state: "needs-you" as const,
          ...(waiting ? { waiting } : {}),
        },
      ],
    });
    useRemoteViewStore
      .getState()
      .refresh("d2", listed({ kind: "permission", text: "Bash npm test", requestId: "r1" }));
    expect(useRemoteViewStore.getState().targets.get(key)?.ask).toEqual({
      requestId: "r1",
      text: "Bash npm test",
    });
    // Waiting with nothing to answer by (an older computer's) is no request here.
    useRemoteViewStore.getState().refresh("d2", listed({ kind: "permission", text: "Bash" }));
    expect(useRemoteViewStore.getState().targets.get(key)?.ask).toBeUndefined();
    useRemoteViewStore.getState().refresh(
      "d2",
      listed({
        kind: "permission",
        text: "Edit a.ts",
        requestId: "r2",
        always: true,
        subagent: false,
      }),
    );
    // What it may be answered with, as a computer of 0.13.2 on tells it.
    expect(useRemoteViewStore.getState().targets.get(key)?.ask).toEqual({
      requestId: "r2",
      text: "Edit a.ts",
      always: true,
      subagent: false,
    });
    useRemoteViewStore.getState().refresh("d2", listed());
    expect(useRemoteViewStore.getState().targets.get(key)).not.toHaveProperty("ask");
  });

  it("a chat never takes up a request to answer as a terminal's", () => {
    useRemoteViewStore.getState().open(target);
    useRemoteViewStore.getState().refresh("d2", {
      workspaces: [{ id: "w1", name: "api", path: "/src/api" }],
      sessions: [
        {
          workspaceId: "w1",
          tabId: "t1",
          kind: "claude" as const,
          title: "Fix the build",
          state: "needs-you" as const,
          waiting: { text: "Run bun test?", requestId: "r1" },
        },
      ],
    });
    expect(useRemoteViewStore.getState().targets.get(KEY)).not.toHaveProperty("ask");
  });

  it("stays in the panels as this computer's tabs close", () => {
    expect(staysInPanels(KEY)).toBe(true);
    expect(staysInPanels("ws-gone:t1")).toBe(false);
  });
});

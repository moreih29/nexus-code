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

  it("stays in the panels as this computer's tabs close", () => {
    expect(staysInPanels(KEY)).toBe(true);
    expect(staysInPanels("ws-gone:t1")).toBe(false);
  });
});

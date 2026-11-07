/**
 * The agent view's store: what was stored comes back with only the agents
 * whose tabs still exist, and a change is stored once things settle, never
 * before what was stored came back.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const stored: unknown[] = [];

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    if (channel === "appState" && method === "set") stored.push(args);
    return Promise.resolve({ ok: true as const, value: undefined });
  },
}));

const { __resetAgentViewForTests, useAgentViewStore } = await import(
  "../../../../../src/renderer/state/stores/agent-view"
);
const { openKey } = await import("../../../../../src/renderer/services/agent-view/layout");

const P1 = "00000000-0000-4000-8000-0000000000a1";
const P2 = "00000000-0000-4000-8000-0000000000a2";
const A = "ws-a:t1";
const B = "ws-b:t2";

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

describe("agent view store", () => {
  beforeEach(() => {
    stored.length = 0;
    __resetAgentViewForTests();
  });

  afterEach(() => {
    __resetAgentViewForTests();
  });

  it("restores the mode and the panels, without the agents whose tabs closed", () => {
    useAgentViewStore.getState().hydrate(
      {
        mode: "agents",
        root: {
          kind: "split",
          id: "00000000-0000-4000-8000-0000000000b1",
          orientation: "horizontal",
          ratio: 0.4,
          first: { kind: "leaf", id: P1, tabIds: [A], activeTabId: A },
          second: { kind: "leaf", id: P2, tabIds: [B], activeTabId: B },
        },
        activeLeafId: P2,
      },
      (key) => key === A,
    );
    const state = useAgentViewStore.getState();
    expect(state.mode).toBe("agents");
    expect(state.root).toEqual({ kind: "leaf", id: P1, tabIds: [A], activeTabId: A });
    expect(state.activeLeafId).toBe(P1);
  });

  it("stores nothing before what was stored came back", async () => {
    useAgentViewStore.getState().setMode("agents");
    await settle();
    expect(stored).toEqual([]);
  });

  it("stores the mode and the panels once a change settles", async () => {
    useAgentViewStore.getState().hydrate(undefined, () => true);
    useAgentViewStore.getState().setMode("agents");
    useAgentViewStore.getState().update((layout) => openKey(layout, A));
    await settle();
    expect(stored).toHaveLength(1);
    const { agentView } = stored[0] as { agentView: { mode: string; root: { tabIds: string[] } } };
    expect(agentView.mode).toBe("agents");
    expect(agentView.root.tabIds).toEqual([A]);
  });

  it("stores nothing for a change that changes nothing", async () => {
    useAgentViewStore.getState().hydrate(undefined, () => true);
    useAgentViewStore.getState().update((layout) => layout);
    await settle();
    expect(stored).toEqual([]);
  });
});

/**
 * The sessions tab's view: a workspace's own choice, else the default from
 * Settings, else the tree — each saved to appState, and a view this version
 * does not know dropped on load.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const writes: unknown[] = [];

const CLIENT = "../../../../../src/renderer/ipc/client";

// Other files mock the IPC client process-wide, so this file installs its
// own and puts back whatever it found when it is done.
const previousClient = { ...(await import(CLIENT)) };
mock.module(CLIENT, () => ({
  ...previousClient,
  ipcCallResult: (_channel: string, _method: string, args: unknown) => {
    writes.push(args);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));
afterAll(() => {
  mock.module(CLIENT, () => previousClient);
});

const { selectSessionsView, useSessionsViewStore } = await import(
  "../../../../../src/renderer/state/stores/sessions-view"
);

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const view = (id: string) => selectSessionsView(useSessionsViewStore.getState(), id);

beforeEach(() => {
  useSessionsViewStore.getState().hydrate({});
  writes.length = 0;
});

describe("sessions view store", () => {
  it("is the tree until something is chosen", () => {
    expect(view(WS)).toBe("tree");
  });

  it("a workspace's choice outranks the default", () => {
    const store = useSessionsViewStore.getState();
    store.setDefault("board");
    expect(view(WS)).toBe("board");
    expect(writes.at(-1)).toEqual({ sessionsViewDefault: "board" });

    store.setForWorkspace(WS, "tree");
    expect(view(WS)).toBe("tree");
    expect(view(OTHER)).toBe("board");
    expect(writes.at(-1)).toEqual({ sessionsViewByWorkspace: { [WS]: "tree" } });
  });

  it("does not save a choice that changes nothing", () => {
    useSessionsViewStore.getState().setForWorkspace(WS, "board");
    useSessionsViewStore.getState().setForWorkspace(WS, "board");
    expect(writes).toHaveLength(1);
  });

  it("drops views it does not know when loading", () => {
    useSessionsViewStore.getState().hydrate({
      sessionsViewDefault: "galaxy",
      sessionsViewByWorkspace: { [WS]: "board", [OTHER]: "galaxy" },
    });
    const state = useSessionsViewStore.getState();
    expect(state.defaultView).toBeUndefined();
    expect(state.byWorkspace).toEqual({ [WS]: "board" });
    expect(view(OTHER)).toBe("tree");
  });
});

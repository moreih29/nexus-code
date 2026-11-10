/**
 * The sessions tab's view: a view this version does not know is dropped on
 * load, and one an earlier version had is read as the one that took its place.
 */

import { describe, expect, it } from "bun:test";
import {
  selectSessionsView,
  useSessionsViewStore,
} from "../../../../../src/renderer/state/stores/sessions-view";

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const view = (id: string) => selectSessionsView(useSessionsViewStore.getState(), id);

describe("sessions view store", () => {
  it("drops views it does not know when loading", () => {
    useSessionsViewStore.getState().hydrate({
      sessionsViewDefault: "galaxy",
      sessionsViewByWorkspace: { [WS]: "task", [OTHER]: "galaxy" },
    });
    const state = useSessionsViewStore.getState();
    expect(state.defaultView).toBeUndefined();
    expect(state.byWorkspace).toEqual({ [WS]: "task" });
    expect(view(OTHER)).toBe("status");
  });

  it("reads a view earlier versions had as the one that took its place", () => {
    useSessionsViewStore.getState().hydrate({
      sessionsViewDefault: "lineage",
      sessionsViewByWorkspace: { [WS]: "tree", [OTHER]: "board" },
    });
    expect(useSessionsViewStore.getState().defaultView).toBe("task");
    expect(view(WS)).toBe("task");
    expect(view(OTHER)).toBe("status");
  });
});

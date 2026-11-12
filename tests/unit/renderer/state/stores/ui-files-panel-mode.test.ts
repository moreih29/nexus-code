import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FILES_PANEL_MODE_DEFAULT, useUIStore } from "../../../../../src/renderer/state/stores/ui";

// The views are stored through appState.set: heard here, not sent.
const stored: unknown[] = [];
const g = globalThis as Record<string, unknown>;
const hadWindow = g.window !== undefined;
const before = hadWindow ? (g.window as Record<string, unknown>).ipc : undefined;
beforeAll(() => {
  if (!hadWindow) g.window = {};
  (g.window as Record<string, unknown>).ipc = {
    call: (channel: string, method: string, args: unknown) => {
      if (channel === "appState" && method === "set") stored.push(args);
      return Promise.resolve(null);
    },
    listen: () => {},
    off: () => {},
  };
});
afterAll(() => {
  if (!hadWindow) g.window = undefined;
  else (g.window as Record<string, unknown>).ipc = before;
});

const modeOf = (workspaceId: string) =>
  useUIStore.getState().filesPanelModes.get(workspaceId) ?? FILES_PANEL_MODE_DEFAULT;

describe("the files panel's view of each workspace", () => {
  test("is the tree until the user switches it", () => {
    useUIStore.getState().hydrate({});
    expect(modeOf("ws-a")).toBe("tree");
  });

  test("is stored as it changes, every workspace's in one record", () => {
    useUIStore.getState().hydrate({});
    stored.length = 0;
    useUIStore.getState().setFilesPanelMode("ws-a", "agents");
    useUIStore.getState().setFilesPanelMode("ws-b", "git");
    expect(modeOf("ws-a")).toBe("agents");
    expect(stored.at(-1)).toEqual({
      filesPanelModeByWorkspace: { "ws-a": "agents", "ws-b": "git" },
    });
  });

  test("is not stored again when it does not change", () => {
    useUIStore.getState().hydrate({ filesPanelModeByWorkspace: { "ws-a": "search" } });
    stored.length = 0;
    useUIStore.getState().setFilesPanelMode("ws-a", "search");
    useUIStore.getState().setFilesPanelMode("ws-c", "tree");
    expect(stored).toEqual([]);
  });

  test("is restored as stored, but a view this version lacks shows the tree", () => {
    useUIStore.getState().hydrate({
      filesPanelModeByWorkspace: { "ws-a": "agents", "ws-b": "timeline" },
    });
    expect(modeOf("ws-a")).toBe("agents");
    expect(modeOf("ws-b")).toBe("tree");
    expect(useUIStore.getState().filesPanelModes.has("ws-b")).toBe(false);
  });
});

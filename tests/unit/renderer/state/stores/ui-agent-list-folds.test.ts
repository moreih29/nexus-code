import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useUIStore } from "../../../../../src/renderer/state/stores/ui";

// The folds are stored through appState.set: heard here, not sent.
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

const folded = () => [...useUIStore.getState().agentListFoldedGroups].sort();

describe("the agent list's folded groups", () => {
  test("are none until the user folds one: every group starts open", () => {
    useUIStore.getState().hydrate({});
    expect(folded()).toEqual([]);
  });

  test("are the ones the user folded, stored as they change; a second click opens one again", () => {
    useUIStore.getState().hydrate({});
    stored.length = 0;
    useUIStore.getState().toggleAgentListGroup("idle");
    useUIStore.getState().toggleAgentListGroup("running");
    expect(folded()).toEqual(["idle", "running"]);
    useUIStore.getState().toggleAgentListGroup("idle");
    expect(folded()).toEqual(["running"]);
    expect(stored.at(-1)).toEqual({ agentListFoldedGroups: ["running"] });
  });

  test("are restored as stored", () => {
    useUIStore.getState().hydrate({ agentListFoldedGroups: ["ended", "done"] });
    expect(folded()).toEqual(["done", "ended"]);
  });
});

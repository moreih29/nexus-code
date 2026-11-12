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

const unfolded = () => [...useUIStore.getState().agentListUnfoldedTasks].sort();

describe("the task view's unfolded worktrees", () => {
  test("are none until the user opens one: every worktree starts folded", () => {
    useUIStore.getState().hydrate({});
    expect(unfolded()).toEqual([]);
  });

  test("are the ones the user opened, stored as they change; a second click folds one again", () => {
    useUIStore.getState().hydrate({});
    stored.length = 0;
    useUIStore.getState().toggleAgentListTask("ws-a");
    useUIStore.getState().toggleAgentListTask("ws-b");
    expect(unfolded()).toEqual(["ws-a", "ws-b"]);
    useUIStore.getState().toggleAgentListTask("ws-a");
    expect(unfolded()).toEqual(["ws-b"]);
    expect(stored.at(-1)).toEqual({ agentListUnfoldedTasks: ["ws-b"] });
  });

  test("are restored as stored, apart from the folded groups", () => {
    useUIStore.getState().hydrate({ agentListUnfoldedTasks: ["ws-c"] });
    expect(unfolded()).toEqual(["ws-c"]);
    expect(folded()).toEqual([]);
  });
});

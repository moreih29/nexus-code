/** A task made behind the user's view: a plain shell opens no tab until the task is shown. */
import { afterAll, beforeEach, expect, test } from "bun:test";

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;
const task = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "pay",
  location: { kind: "local", rootPath: "/w/pay" },
  rootPath: "/w/pay",
  colorTone: "default",
  pinned: false,
  lastOpenedAt: "2026-11-15T00:00:00.000Z",
  tabs: [],
  sortOrder: 1,
  pinnedSortOrder: 0,
  task: { parentId: "p", branch: "pay", worktreePath: "/w/pay" },
};
globals.window = {
  ...(originalWindow as object),
  ipc: {
    call: (channel: string, method: string) =>
      Promise.resolve(channel === "task" && method === "create" ? task : null),
    listen: () => () => {},
    off: () => {},
  },
};
afterAll(() => {
  globals.window = originalWindow;
});

const { startTask } = await import("../../../../src/renderer/services/workspace/tasks");
const { useTabsStore } = await import("../../../../src/renderer/state/stores/tabs");

beforeEach(() => useTabsStore.setState({ byWorkspace: {} }));

test("a plain shell opens no tab: the task's panel opens one when it is shown", async () => {
  const started = await startTask("p", "pay", "", { command: "" });
  expect("task" in started && [started.tabId, started.start]).toEqual([null, { command: "" }]);
  expect(Object.keys(useTabsStore.getState().byWorkspace[task.id] ?? {})).toEqual([]);
});

test("a command opens its terminal, which runs it once started", async () => {
  const started = await startTask("p", "pay", "fix it", { command: "codex" });
  if (!("task" in started) || started.tabId === null) throw new Error("no terminal opened");
  const tab = useTabsStore.getState().byWorkspace[task.id]?.[started.tabId];
  expect(tab?.type).toBe("terminal");
  expect(started.start).toEqual({ command: "codex" });
});

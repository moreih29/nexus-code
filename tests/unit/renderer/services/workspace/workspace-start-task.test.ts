import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { TerminalOpener } from "../../../../../src/shared/chat/relay";

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;
const task = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "pay",
  location: { kind: "local", rootPath: "/w/pay" },
  rootPath: "/w/pay",
  color: "auto",
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

const agentTab = await import("../../../../../src/renderer/services/chat/agent-tab");
const { startTask } = await import("../../../../../src/renderer/services/workspace/tasks");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");

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

test.each([
  { agent: "claude" },
  { agent: "codex" },
  { command: "codex" },
] as const)("a task's first tab keeps its opener with start %j", async (start) => {
  const openedBy: TerminalOpener = { kind: "tab", agent: "codex", tabId: "plan" };
  const opened = await startTask("p", "pay", "", start, undefined, undefined, openedBy);
  if (!("task" in opened) || opened.tabId === null) throw new Error("no tab opened");
  const user = await startTask("p", "pay", "", start);
  if (!("task" in user) || user.tabId === null) throw new Error("no tab opened");
  const tabs = useTabsStore.getState().byWorkspace[task.id];
  expect(tabs?.[opened.tabId]?.props).toHaveProperty("openedBy", openedBy);
  expect(tabs?.[user.tabId]?.props).not.toHaveProperty("openedBy");
});

test.each([
  false,
  true,
])("startTask waits for preparation and starts with fallback on failure=%s", async (fails) => {
  const tabId = "prepared";
  const openedBy: TerminalOpener = { kind: "tab", agent: "claude", tabId: "source" };
  const open = spyOn(agentTab, "openAgentTab").mockReturnValue(tabId);
  const start = spyOn(agentTab, "startAgentTab").mockImplementation(() => {});
  const entered = Promise.withResolvers<void>();
  const continueStart = Promise.withResolvers<void>();
  try {
    const starting = startTask(
      "p",
      "pay",
      "Task prompt with report",
      { agent: "codex" },
      undefined,
      undefined,
      openedBy,
      {
        fallbackPrompt: "Task prompt only",
        async beforeAgentStart(workspace, tab) {
          entered.resolve();
          expect(workspace.id).toBe(task.id);
          expect(tab).toBe(tabId);
          await continueStart.promise;
          if (fails) throw new Error("link failed");
        },
      },
    );
    try {
      await entered.promise;
      expect(open).toHaveBeenCalledWith(
        task.id,
        "codex",
        task.rootPath,
        "",
        undefined,
        undefined,
        openedBy,
      );
      expect(start).not.toHaveBeenCalled();
    } finally {
      continueStart.resolve();
    }
    const started = await starting;
    expect("task" in started && Boolean(started.preparationFailed)).toBe(fails);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      task.id,
      tabId,
      fails ? "Task prompt only" : "Task prompt with report",
      undefined,
    );
  } finally {
    open.mockRestore();
    start.mockRestore();
  }
});

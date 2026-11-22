/** The renderer's count of changes to the sessions, and when main is told of one. */
import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";
import { ipcErr } from "../../../../../src/shared/ipc/result";

const told: number[] = [];
let nextNotice: Promise<unknown> | undefined;
const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;
globals.window = {
  ...(originalWindow as object),
  ipc: {
    call: (channel: string, method: string, args: { revision: number }) => {
      if (channel === "cli" && method === "sessionsChanged") {
        told.push(args.revision);
        const response = nextNotice;
        nextNotice = undefined;
        if (response) return response;
      }
      return Promise.resolve(null);
    },
    listen: () => () => {},
    off: () => {},
  },
};
afterAll(() => {
  globals.window = originalWindow;
});

const { readSessionsRevision, sameActivity, sessionsRevision, startSessionsRevision } =
  await import("../../../../../src/renderer/services/cli/sessions-revision");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { publishTabActivity, useTabActivityStore } = await import(
  "../../../../../src/renderer/state/stores/tab-activity"
);
const { useAgentProfilesStore } = await import(
  "../../../../../src/renderer/state/stores/agent-profiles"
);
const { registerTerminalController } = await import(
  "../../../../../src/renderer/services/terminal/terminal-registry"
);
const { BUSY_WINDOW_MS } = await import("../../../../../src/shared/sessions/agent-state");

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));
let stop = () => {};

beforeEach(async () => {
  stop = startSessionsRevision();
  await settle();
  readSessionsRevision();
  told.length = 0;
});

afterEach(() => {
  stop();
  useTabActivityStore.setState({ activity: new Map() });
});

test("main is told the first change after each read, with the count at the end of its burst", async () => {
  const at = sessionsRevision();
  useTabsStore.getState().createTab("ws-rev", { type: "terminal", props: { cwd: "/" } });
  useTabsStore.getState().createTab("ws-rev", { type: "terminal", props: { cwd: "/" } });
  await settle();
  expect(told).toEqual([at + 2]);
  useTabsStore.getState().createTab("ws-rev", { type: "terminal", props: { cwd: "/" } });
  await settle();
  expect(told).toHaveLength(1);
  expect(sessionsRevision()).toBe(at + 3);
  // Read: the next change is news again.
  expect(readSessionsRevision()).toBe(at + 3);
  useAgentProfilesStore.setState({});
  await settle();
  expect(told).toEqual([at + 2, at + 4]);
  useTabsStore.setState({ byWorkspace: {} });
});

test.each([
  "rejection",
  "error result",
])("a failed notice (%s) is retried on the next change", async (failure) => {
  const notice = Promise.withResolvers<unknown>();
  nextNotice = notice.promise;
  const at = sessionsRevision();
  useAgentProfilesStore.setState({});
  await settle();
  if (failure === "rejection") notice.reject(new Error("IPC disconnected"));
  else notice.resolve(ipcErr("notice", "IPC failed"));
  for (let i = 0; i < 5; i++) await settle();
  useAgentProfilesStore.setState({});
  await settle();
  expect(told).toEqual([at + 1, at + 2]);
});

test("a failed notice from before a read leaves its newer notice in place", async () => {
  const old = Promise.withResolvers<unknown>();
  nextNotice = old.promise;
  const at = sessionsRevision();
  useAgentProfilesStore.setState({});
  await settle();
  readSessionsRevision();
  useAgentProfilesStore.setState({});
  await settle();
  old.reject(new Error("old notice failed"));
  for (let i = 0; i < 5; i++) await settle();
  useAgentProfilesStore.setState({});
  await settle();
  expect(told).toEqual([at + 1, at + 2]);
});

test("an activity read that tells the same is no change; a terminal starting is", async () => {
  const activity = new Map([["w:t", { lastOutputAt: 1_000, program: "codex" }]]);
  publishTabActivity(activity, 1);
  await settle();
  readSessionsRevision();
  const at = sessionsRevision();
  publishTabActivity(new Map([["w:t", { lastOutputAt: 1_000, program: "codex" }]]), 2);
  expect(sessionsRevision()).toBe(at);
  publishTabActivity(new Map([["w:t", { lastOutputAt: 1_000, program: "claude" }]]), 3);
  expect(sessionsRevision()).toBe(at + 1);
  const unregister = registerTerminalController(
    "t-rev",
    {} as Parameters<typeof registerTerminalController>[1],
  );
  expect(sessionsRevision()).toBe(at + 2);
  unregister();
  expect(sessionsRevision()).toBe(at + 3);
});

test("a terminal's busy spell running out is a change", () => {
  jest.useFakeTimers();
  try {
    useTabActivityStore.setState({
      activity: new Map([["w:t", { lastOutputAt: Date.now(), program: "codex" }]]),
      readAt: Date.now(),
    });
    const at = sessionsRevision();
    jest.advanceTimersByTime(BUSY_WINDOW_MS - 1);
    expect(sessionsRevision()).toBe(at);
    jest.advanceTimersByTime(100);
    expect(sessionsRevision()).toBe(at + 1);
    jest.advanceTimersByTime(10_000);
    expect(sessionsRevision()).toBe(at + 1);
  } finally {
    jest.useRealTimers();
  }
});

test("activity reads compare by what they tell of each terminal", () => {
  const notice = { title: "Codex", body: "Done", at: 5 };
  const a = new Map([["w:t", { lastOutputAt: 1, program: "codex", lastNotice: notice }]]);
  expect(sameActivity(a, new Map([["w:t", { ...a.get("w:t")!, lastNotice: { ...notice } }]]))).toBe(
    true,
  );
  expect(
    sameActivity(
      a,
      new Map([
        ["w:t", { lastOutputAt: 1, program: "codex", lastNotice: { ...notice, body: "x" } }],
      ]),
    ),
  ).toBe(false);
  expect(sameActivity(a, new Map())).toBe(false);
  expect(sameActivity(a, new Map([["w:u", a.get("w:t")!]]))).toBe(false);
});

test("one count runs, however often it starts; a stop from before leaves the one after", () => {
  const older = startSessionsRevision();
  stop = startSessionsRevision();
  older();
  const at = sessionsRevision();
  useAgentProfilesStore.setState({});
  expect(sessionsRevision()).toBe(at + 1);
});

/** The renderer's side of the nexus CLI: one listener, so each request is carried out once. */
import { afterAll, expect, test } from "bun:test";

type Listener = (args: unknown) => void;
/** The cli:uiRequest listeners; other modules listen to other events on import. */
const listeners = new Set<Listener>();
const calls: unknown[][] = [];

const globals = globalThis as { window?: unknown; document?: unknown };
const originalWindow = globals.window;
const originalDocument = globals.document;
// A request notes what holds the keyboard, to give it back after.
globals.document ??= { activeElement: null, body: null, hasFocus: () => false };
globals.window = {
  ...(originalWindow as object),
  ipc: {
    call: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(null);
    },
    listen: (channel: string, event: string, callback: Listener) => {
      if (channel !== "cli" || event !== "uiRequest") return () => {};
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    off: () => {},
  },
};

afterAll(() => {
  globals.window = originalWindow;
  globals.document = originalDocument;
});

const { listTabs, markCliUiReady, startCliUiListener } = await import(
  "../../../../../src/renderer/services/cli/ui-requests"
);
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useLayoutStore } = await import("../../../../../src/renderer/state/stores/layout/store");
const { registerTerminalController, whenTerminalController } = await import(
  "../../../../../src/renderer/services/terminal/terminal-registry"
);
const { useMountedWorkspacesStore } = await import(
  "../../../../../src/renderer/state/stores/mounted-workspaces"
);

/** What the renderer answered a request, once it has. */
async function answerTo(requestId: string, op: string, args: unknown): Promise<unknown> {
  for (const listener of listeners) listener({ requestId, op, args });
  for (let i = 0; i < 100; i++) {
    const answer = calls.find(
      ([channel, method, body]) =>
        channel === "cli" &&
        method === "uiRespond" &&
        (body as { requestId?: string })?.requestId === requestId,
    );
    if (answer) return answer[2];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no answer to ${requestId}`);
}

test("a request is carried out once, however often the app boots", async () => {
  startCliUiListener();
  startCliUiListener();
  const stop = startCliUiListener();
  expect(listeners.size).toBe(1);

  markCliUiReady();
  for (const listener of listeners) listener({ requestId: "r1", op: "no.such.op", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const answers = calls.filter(([channel, method]) => channel === "cli" && method === "uiRespond");
  expect(answers).toHaveLength(1);
  expect(answers[0]?.[2]).toMatchObject({ requestId: "r1", ok: false });

  stop();
  expect(listeners.size).toBe(0);
  // A stop from before leaves the listener installed after it.
  const older = startCliUiListener();
  startCliUiListener();
  older();
  expect(listeners.size).toBe(1);
});

test("a terminal not started yet, its workspace not opened, says so in the tabs' list", () => {
  const ws = "ws-tabs";
  const make = () =>
    useTabsStore.getState().createTab(ws, { type: "terminal", props: { cwd: "/" } });
  const started = make();
  const unstarted = make();
  useLayoutStore.setState({
    byWorkspace: {
      [ws]: {
        root: {
          kind: "leaf",
          id: "leaf",
          tabIds: [started.id, unstarted.id],
          activeTabId: started.id,
        },
        activeGroupId: "leaf",
      },
    },
  });
  const unregister = registerTerminalController(
    started.id,
    {} as Parameters<typeof registerTerminalController>[1],
  );
  try {
    expect(listTabs(ws).map((tab) => [tab.id, tab.unstarted])).toEqual([
      [started.id, undefined],
      [unstarted.id, true],
    ]);
  } finally {
    unregister();
    useTabsStore.setState({ byWorkspace: {} });
    useLayoutStore.setState({ byWorkspace: {} });
  }
});

test("a terminal not started yet is started behind the view, and read once it has", async () => {
  const ws = "ws-later";
  const tab = useTabsStore.getState().createTab(ws, { type: "terminal", props: { cwd: "/" } });
  startCliUiListener();
  markCliUiReady();
  let unregister = () => {};
  try {
    const answer = answerTo("r-later", "terminal.read", {
      workspaceId: ws,
      tabId: tab.id,
      lines: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Its workspace's panel mounts, and with it the terminal's view.
    expect(useMountedWorkspacesStore.getState().ids.has(ws)).toBe(true);
    unregister = registerTerminalController(tab.id, {
      readText: () => "ready",
    } as unknown as Parameters<typeof registerTerminalController>[1]);
    expect(await answer).toMatchObject({
      requestId: "r-later",
      ok: true,
      value: { text: "ready" },
    });
  } finally {
    unregister();
    useTabsStore.setState({ byWorkspace: {} });
  }
});

test("a tab that is not a terminal is not waited for", async () => {
  const ws = "ws-editor";
  const tab = useTabsStore
    .getState()
    .createTab(ws, { type: "editor", props: { workspaceId: ws, filePath: "/a.ts" } });
  startCliUiListener();
  markCliUiReady();
  try {
    expect(
      await answerTo("r-editor", "terminal.read", { workspaceId: ws, tabId: tab.id, lines: 5 }),
    ).toMatchObject({ ok: false });
  } finally {
    useTabsStore.setState({ byWorkspace: {} });
  }
});

test("a terminal's view that does not mount in time gives up", async () => {
  expect(await whenTerminalController("never", 10)).toBeUndefined();
});

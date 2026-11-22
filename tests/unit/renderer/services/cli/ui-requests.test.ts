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

const { listTabs, startCliUiListener } = await import(
  "../../../../../src/renderer/services/cli/ui-requests"
);
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useLayoutStore } = await import("../../../../../src/renderer/state/stores/layout/store");
const { useAgentViewStore } = await import("../../../../../src/renderer/state/stores/agent-view");
const { useWorkspacesStore } = await import("../../../../../src/renderer/state/stores/workspaces");
const { useClaudeStatusStore } = await import(
  "../../../../../src/renderer/state/stores/claude-status"
);
const { useSessionSeenStore } = await import(
  "../../../../../src/renderer/state/stores/session-seen"
);
const { chatKey, useChatStore } = await import("../../../../../src/renderer/services/chat/store");
const { startAgentViewPruning } = await import(
  "../../../../../src/renderer/services/agent-view/show"
);
const { registerTerminalController, whenTerminalController } = await import(
  "../../../../../src/renderer/services/terminal/terminal-registry"
);
const { useMountedWorkspacesStore } = await import(
  "../../../../../src/renderer/state/stores/mounted-workspaces"
);
const { SerializedTabSchema } = await import("../../../../../src/shared/types/layout");
const { WorkspaceMetaSchema } = await import("../../../../../src/shared/types/workspace");

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

test.each([
  "claude",
  "codex",
] as const)("a remote receipt marks the finished %s chat", async (kind) => {
  const workspace = WorkspaceMetaSchema.parse({
    id: "21111111-1111-4111-8111-111111111111",
    name: "Project",
    rootPath: "/project",
    pinned: false,
    tabs: [],
  });
  const workspaceId = workspace.id;
  const tabId = useTabsStore
    .getState()
    .createTab(workspaceId, { type: kind, props: { cwd: "/project" } }).id;
  const key = chatKey(workspaceId, tabId);
  const stop = startCliUiListener(Promise.resolve());
  const { workspaces } = useWorkspacesStore.getState();
  const since = Date.now();
  const completedAt = since + 10;
  try {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useChatStore.getState().update(key, (chat) => ({
      ...chat,
      model: {
        ...chat.model,
        lastResult: {
          subtype: "success",
          isError: false,
          at: since,
          ...(kind === "claude" ? { outcome: "success" as const } : {}),
        },
      },
    }));
    if (kind === "claude")
      useClaudeStatusStore
        .getState()
        .set({ workspaceId, tabId, status: "completed", since: completedAt });
    const ack = (upTo: number) =>
      answerTo(`r-seen-${kind}-${upTo}`, "sessions.markSeen", {
        seen: [{ workspaceId, tabId, upTo }],
      });
    expect(await ack(since - 1)).toMatchObject({ ok: true, value: { marked: 0 } });
    expect(await ack(since + 1)).toMatchObject({ ok: true, value: { marked: 1 } });
    expect(useSessionSeenStore.getState().byWorkspace[workspaceId]?.[tabId]).toBe(since);
    const receipt = calls.filter(
      ([channel, method, args]) =>
        channel === "claude" &&
        method === "markSeen" &&
        (args as { tabId: string }).tabId === tabId,
    );
    expect(receipt).toEqual(
      kind === "claude"
        ? [["claude", "markSeen", { workspaceId, tabId, completedAt, resultAt: since }]]
        : [],
    );
  } finally {
    stop();
    useWorkspacesStore.setState({ workspaces });
    useTabsStore.getState().removeTab(workspaceId, tabId);
    useChatStore.getState().remove(key);
    useClaudeStatusStore.getState().clearWorkspace(workspaceId);
    useSessionSeenStore.getState().clearWorkspace(workspaceId);
  }
});

test("a request is carried out once, however often the app boots", async () => {
  startCliUiListener(Promise.resolve());
  startCliUiListener(Promise.resolve());
  const stop = startCliUiListener(Promise.resolve());
  expect(listeners.size).toBe(1);

  for (const listener of listeners) listener({ requestId: "r1", op: "no.such.op", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const answers = calls.filter(
    ([channel, method, args]) =>
      channel === "cli" &&
      method === "uiRespond" &&
      (args as { requestId: string }).requestId === "r1",
  );
  expect(answers).toHaveLength(1);
  expect(answers[0]?.[2]).toMatchObject({ requestId: "r1", ok: false });

  stop();
  expect(listeners.size).toBe(0);
  // A stop from before leaves the listener installed after it.
  const older = startCliUiListener(Promise.resolve());
  startCliUiListener(Promise.resolve());
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

test("remote sessions follow the sidebar across chat and terminal tabs and preserve layout order", async () => {
  const workspace = WorkspaceMetaSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Project",
    rootPath: "/project",
    pinned: false,
    tabs: [],
  });
  const ws = workspace.id;
  const tabs = useTabsStore.getState();
  const view = useAgentViewStore.getState();
  const workspaces = useWorkspacesStore.getState().workspaces;
  const layout = useLayoutStore.getState().byWorkspace;
  const make = (type: "claude" | "codex" | "terminal") =>
    tabs.createTab(ws, { type, props: { cwd: workspace.rootPath } }).id;
  const stopCli = startCliUiListener(Promise.resolve());
  const stopPruning = startAgentViewPruning();
  try {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    const first = make("claude");
    const shell = make("terminal");
    const middle = make("codex");
    const terminal = make("terminal");
    const last = make("claude");
    const otherShell = make("terminal");
    tabs.renameTab(ws, terminal, "codex");
    const tabIds = [otherShell, last, first, terminal, middle, shell];
    useLayoutStore.setState({
      byWorkspace: {
        [ws]: {
          root: { kind: "leaf", id: "leaf", tabIds, activeTabId: shell },
          activeGroupId: "leaf",
        },
      },
    });

    const sessionTabs = async (requestId: string) => {
      const response = (await answerTo(requestId, "tabs.list", {
        workspaceId: ws,
        agentOrder: true,
      })) as { value: { tabs: { id: string }[] } };
      return response.value.tabs.map(({ id }) => id);
    };
    expect(await sessionTabs("r-agent-order")).toEqual([
      first,
      middle,
      terminal,
      last,
      otherShell,
      shell,
    ]);
    expect(
      await answerTo("r-reorder", "agentView.reorderSessions", {
        workspaceId: ws,
        tabIds: [last, "closed", last, shell, first],
      }),
    ).toMatchObject({ ok: true, value: { found: true } });
    expect(useAgentViewStore.getState().order[ws]).toEqual(
      [last, middle, terminal, first].map((id) => `${ws}:${id}`),
    );
    expect(await sessionTabs("r-agent-reordered")).toEqual([
      last,
      middle,
      terminal,
      first,
      otherShell,
      shell,
    ]);
    expect(listTabs(ws).map(({ id }) => id)).toEqual(tabIds);

    tabs.removeTab(ws, middle);
    expect(useAgentViewStore.getState().order[ws]).toEqual(
      [last, terminal, first].map((id) => `${ws}:${id}`),
    );
    const newChat = make("codex");
    useLayoutStore.setState({
      byWorkspace: {
        [ws]: {
          root: {
            kind: "leaf",
            id: "leaf",
            tabIds: [newChat, ...tabIds.filter((id) => id !== middle)],
            activeTabId: shell,
          },
          activeGroupId: "leaf",
        },
      },
    });
    expect(await sessionTabs("r-agent-new")).toEqual([
      last,
      terminal,
      first,
      newChat,
      otherShell,
      shell,
    ]);
  } finally {
    stopPruning();
    stopCli();
    useAgentViewStore.setState({ order: view.order });
    useTabsStore.setState({ byWorkspace: tabs.byWorkspace });
    useLayoutStore.setState({ byWorkspace: layout });
    useWorkspacesStore.setState({ workspaces });
  }
});

test.each([
  "terminal",
  "claude",
  "codex",
] as const)("a %s tab an agent opens keeps who opened it, listed and across a restart", async (type) => {
  const ws = `ws-opened-${type}`;
  const openedBy = { kind: "tab", agent: "codex", name: "Plan", workspaceId: ws, tabId: "t-plan" };
  startCliUiListener(Promise.resolve());
  try {
    const open = (requestId: string, by?: object) =>
      answerTo(requestId, type === "terminal" ? "terminal.open" : "chat.open", {
        workspaceId: ws,
        cwd: "/",
        placement: { background: true },
        ...(type === "terminal" ? {} : { agent: type, prompt: "" }),
        ...(by ? { openedBy: by } : {}),
      }) as Promise<{ ok: boolean; value: { tabId: string } }>;
    const agents = await open(`r-${type}-agent`, openedBy);
    const users = await open(`r-${type}-user`);
    expect([agents.ok, users.ok]).toEqual([true, true]);
    const reply = (await answerTo(`r-${type}-list`, "tabs.list", { workspaceId: ws })) as {
      ok: boolean;
      value: { tabs: ReturnType<typeof listTabs> };
    };
    expect(reply.ok).toBe(true);
    const listed = Object.fromEntries(reply.value.tabs.map((tab) => [tab.id, tab.openedBy]));
    expect(listed).toEqual({ [agents.value.tabId]: openedBy, [users.value.tabId]: undefined });
    const saved = useTabsStore.getState().byWorkspace[ws]?.[agents.value.tabId];
    const restored = SerializedTabSchema.parse(JSON.parse(JSON.stringify(saved)));
    expect(restored).toMatchObject({ type, props: { openedBy } });
    expect(
      SerializedTabSchema.safeParse({ ...restored, props: { cwd: "/", openedBy: { kind: "app" } } })
        .success,
    ).toBe(false);
  } finally {
    useTabsStore.setState({ byWorkspace: {} });
    useLayoutStore.setState({ byWorkspace: {} });
  }
});

test("a terminal not started yet is started behind the view, and read once it has", async () => {
  const ws = "ws-later";
  const tab = useTabsStore.getState().createTab(ws, { type: "terminal", props: { cwd: "/" } });
  startCliUiListener(Promise.resolve());
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
      whenReady: () => Promise.resolve(true),
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

test("a terminal its view has registered is typed into only once its shell is ready", async () => {
  const ws = "ws-opening";
  const tab = useTabsStore.getState().createTab(ws, { type: "terminal", props: { cwd: "/" } });
  startCliUiListener(Promise.resolve());
  const typed: string[] = [];
  let open = (_ready: boolean) => {};
  // Its fonts still loading, or its shell not at its prompt: input would be lost.
  const unregister = registerTerminalController(tab.id, {
    whenReady: () =>
      new Promise<boolean>((resolve) => {
        open = resolve;
      }),
    input: (text: string) => {
      typed.push(text);
      return true;
    },
  } as unknown as Parameters<typeof registerTerminalController>[1]);
  try {
    const answer = answerTo("r-opening", "terminal.input", {
      workspaceId: ws,
      tabId: tab.id,
      text: "echo hi",
      mode: "paste",
      enter: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(typed).toEqual([]);
    open(true);
    expect(await answer).toMatchObject({ requestId: "r-opening", ok: true });
    expect(typed).toEqual(["echo hi"]);
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
  startCliUiListener(Promise.resolve());
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

test("a request that only reads schedules no focus checks; one that may move tabs does", async () => {
  const doc = globals.document as { activeElement: unknown; body: unknown };
  const before = doc.activeElement;
  const frames: unknown[] = [];
  const raf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (run: unknown) => {
    frames.push(run);
    return frames.length;
  };
  // The composer the user types in holds the keyboard.
  doc.activeElement = { isConnected: true, focus: () => {}, closest: () => null };
  const stop = startCliUiListener(Promise.resolve());
  try {
    await answerTo("r-read-tabs", "tabs.list", { workspaceId: "ws-none" });
    await answerTo("r-read-events", "events.read", { limit: 1 });
    await answerTo("r-read-chat", "chat.state", { workspaceId: "ws-none", tabId: "t", peek: true });
    expect(frames).toHaveLength(0);
    await answerTo("r-rename", "tab.rename", { workspaceId: "ws-none", tabId: "t", title: "x" });
    expect(frames).toHaveLength(1);
  } finally {
    stop();
    doc.activeElement = before;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
  }
});

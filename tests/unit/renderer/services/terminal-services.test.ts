import { beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  PtyClientOptions,
  TerminalDimensions,
} from "../../../../src/renderer/services/terminal/types";
import type { TerminalControllerDeps } from "../../../../src/renderer/services/terminal/controller";

type IpcCallRecord = { channel: string; method: string; args: unknown };
type ListenerRecord = { channel: string; event: string; callback: (args: unknown) => void };

const ipcCalls: IpcCallRecord[] = [];
const listeners: ListenerRecord[] = [];

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock((channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    if (channel === "pty" && method === "spawn") return Promise.resolve({ pid: 1234 });
    return Promise.resolve(undefined);
  }),
  ipcListen: mock((channel: string, event: string, callback: (args: unknown) => void) => {
    const record = { channel, event, callback };
    listeners.push(record);
    return () => {
      const index = listeners.indexOf(record);
      if (index >= 0) listeners.splice(index, 1);
    };
  }),
}));

const { closeTerminal, createTerminalController, openTerminal } = await import(
  "../../../../src/renderer/services/terminal"
);
const { TERMINAL_REOPENED_SEPARATOR } = await import(
  "../../../../src/renderer/services/terminal/controller"
);
const { createPtyClient } = await import("../../../../src/renderer/services/terminal/pty-client");
const { closeGroup } = await import("../../../../src/renderer/state/operations");
const { useLayoutStore } = await import("../../../../src/renderer/state/stores/layout");
const { findLeaf } = await import("../../../../src/renderer/state/stores/layout/helpers");
const { useTabsStore } = await import("../../../../src/renderer/state/stores/tabs");

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const OTHER_WS = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

function resetStores(): void {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function resetIpc(): void {
  ipcCalls.length = 0;
  listeners.length = 0;
}

function tabsFor(workspaceId: string) {
  return Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {});
}

function emit(channel: string, event: string, args: unknown): void {
  for (const listener of [...listeners]) {
    if (listener.channel === channel && listener.event === event) listener.callback(args);
  }
}

function killCalls(): IpcCallRecord[] {
  return ipcCalls.filter((call) => call.channel === "pty" && call.method === "kill");
}

async function flushTerminalInit(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeTerminalControllerDeps(
  spawnImpl: (dimensions: TerminalDimensions) => Promise<{ pid: number } | null> = () =>
    Promise.resolve({ pid: 4321 }),
) {
  const writes: string[] = [];
  const spawnCalls: TerminalDimensions[] = [];
  let ptyOptions: PtyClientOptions | null = null;
  const deps: TerminalControllerDeps = {
    waitForTerminalFonts: () => Promise.resolve(),
    createTerminal: () => ({
      element: undefined,
      rows: 24,
      dispose: () => {},
      loadAddon: () => {},
      onData: () => ({ dispose: () => {} }),
      open: () => {},
      refresh: () => {},
      write: (data) => {
        writes.push(data);
      },
    }),
    createFitAddon: () => ({
      dispose: () => {},
      fit: () => {},
      proposeDimensions: () => ({ cols: 100, rows: 40 }),
    }),
    createWebglAddon: () => {
      throw new Error("webgl disabled in unit test");
    },
    createCanvasAddon: () => ({ dispose: () => {} }) as never,
    createPtyClient: (options) => {
      ptyOptions = options;
      return {
        spawn: (dimensions) => {
          spawnCalls.push({ ...dimensions });
          return spawnImpl(dimensions);
        },
        write: () => {},
        resize: () => {},
        dispose: () => {},
      };
    },
    createResizeObserver: () => ({ observe: () => {}, disconnect: () => {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  return { deps, spawnCalls, writes, getPtyOptions: () => ptyOptions };
}

describe("services/terminal open and close", () => {
  beforeEach(() => {
    resetStores();
    resetIpc();
  });

  it("openTerminal always creates a new terminal tab", () => {
    const first = openTerminal({ workspaceId: WS, cwd: "/workspace" });
    const second = openTerminal({ workspaceId: WS, cwd: "/workspace" });

    expect(first.tabId).not.toBe(second.tabId);
    expect(first.groupId).toBe(second.groupId);
    expect(tabsFor(WS)).toHaveLength(2);
  });

  it("openTerminal routes to an explicit groupId", () => {
    openTerminal({ workspaceId: WS, cwd: "/left" });
    const layout = useLayoutStore.getState().byWorkspace[WS];
    if (!layout) throw new Error("layout missing");
    const leftGroupId = layout.activeGroupId;
    const rightGroupId = useLayoutStore
      .getState()
      .splitGroup(WS, leftGroupId, "horizontal", "after");

    const terminal = openTerminal({ workspaceId: WS, cwd: "/right" }, { groupId: rightGroupId });

    const nextLayout = useLayoutStore.getState().byWorkspace[WS];
    if (!nextLayout) throw new Error("layout missing");
    const rightLeaf = findLeaf(nextLayout.root, rightGroupId);

    expect(terminal.groupId).toBe(rightGroupId);
    expect(rightLeaf?.tabIds).toContain(terminal.tabId);
    expect(nextLayout.activeGroupId).toBe(rightGroupId);
  });

  it("openTerminal supports newSplit", () => {
    const first = openTerminal({ workspaceId: WS, cwd: "/workspace" });
    const second = openTerminal(
      { workspaceId: WS, cwd: "/workspace" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );

    const layout = useLayoutStore.getState().byWorkspace[WS];
    expect(layout?.root.kind).toBe("split");
    expect(second.groupId).not.toBe(first.groupId);
    expect(second.tabId).not.toBe(first.tabId);
    expect(tabsFor(WS)).toHaveLength(2);
  });

  it("closeTerminal kills the PTY session and closes the tab transaction", () => {
    const terminal = openTerminal({ workspaceId: WS, cwd: "/workspace" });

    closeTerminal(terminal.tabId);

    expect(killCalls()).toEqual([
      { channel: "pty", method: "kill", args: { workspaceId: WS, tabId: terminal.tabId } },
    ]);
    expect(useTabsStore.getState().byWorkspace[WS]?.[terminal.tabId]).toBeUndefined();
    const layout = useLayoutStore.getState().byWorkspace[WS];
    expect(layout?.root.kind).toBe("leaf");
    if (layout?.root.kind === "leaf") expect(layout.root.tabIds).not.toContain(terminal.tabId);
  });

  it("workspace tab-record cleanup kills each terminal session before deleting records", () => {
    const first = openTerminal({ workspaceId: WS, cwd: "/workspace/a" });
    const second = openTerminal({ workspaceId: WS, cwd: "/workspace/b" });
    useTabsStore.getState().createTab(WS, {
      type: "editor",
      props: { workspaceId: WS, filePath: "/workspace/file.ts" },
    });

    useTabsStore.getState().closeAllForWorkspace(WS);

    expect(killCalls()).toEqual([
      { channel: "pty", method: "kill", args: { workspaceId: WS, tabId: first.tabId } },
      { channel: "pty", method: "kill", args: { workspaceId: WS, tabId: second.tabId } },
    ]);
    expect(useTabsStore.getState().byWorkspace[WS]).toBeUndefined();
  });

  it("closeGroup kills terminal sessions in the group before removing their tab records", () => {
    const left = openTerminal({ workspaceId: WS, cwd: "/workspace/left" });
    const rightGroupId = useLayoutStore
      .getState()
      .splitGroup(WS, left.groupId, "horizontal", "after");
    const right = openTerminal(
      { workspaceId: WS, cwd: "/workspace/right" },
      { groupId: rightGroupId },
    );
    const editor = useTabsStore.getState().createTab(WS, {
      type: "editor",
      props: { workspaceId: WS, filePath: "/workspace/file.ts" },
    });
    useLayoutStore.getState().attachTab(WS, rightGroupId, editor.id);

    closeGroup(WS, rightGroupId);

    expect(killCalls()).toEqual([
      { channel: "pty", method: "kill", args: { workspaceId: WS, tabId: right.tabId } },
    ]);
    const wsTabs = useTabsStore.getState().byWorkspace[WS];
    expect(wsTabs?.[left.tabId]).toBeDefined();
    expect(wsTabs?.[right.tabId]).toBeUndefined();
    expect(wsTabs?.[editor.id]).toBeUndefined();
  });

  it("terminal controller dispose does not kill the PTY session", async () => {
    const controller = createTerminalController({
      workspaceId: WS,
      tabId: "controller-no-kill",
      cwd: "/workspace",
      container: {} as HTMLElement,
    });

    controller.dispose();
    await Promise.resolve();

    expect(killCalls()).toEqual([]);
  });
});

describe("services/terminal pty-client flow control", () => {
  beforeEach(resetIpc);

  it("acks PTY data each time a tab reaches the 5000-char threshold", () => {
    const received: string[] = [];
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-flow-a",
      cwd: "/workspace",
      onData: (chunk) => received.push(chunk),
      onExit: () => {},
    });

    emit("pty", "data", { workspaceId: WS, tabId: "tab-flow-a", chunk: "a".repeat(4999) });
    expect(ipcCalls.filter((call) => call.method === "ack")).toHaveLength(0);

    emit("pty", "data", { workspaceId: WS, tabId: "tab-flow-a", chunk: "b" });

    expect(received.join("").length).toBe(5000);
    expect(ipcCalls).toContainEqual({
      channel: "pty",
      method: "ack",
      args: { workspaceId: WS, tabId: "tab-flow-a", bytesConsumed: 5000 },
    });

    client.dispose();
  });

  it("keeps ACK counters module-private and isolated by tabId", () => {
    const clientA = createPtyClient({
      workspaceId: WS,
      tabId: "tab-flow-b-a",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {},
    });
    const clientB = createPtyClient({
      workspaceId: WS,
      tabId: "tab-flow-b-b",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {},
    });

    emit("pty", "data", { workspaceId: WS, tabId: "tab-flow-b-a", chunk: "a".repeat(3000) });
    emit("pty", "data", { workspaceId: WS, tabId: "tab-flow-b-b", chunk: "b".repeat(3000) });
    emit("pty", "data", { workspaceId: WS, tabId: "tab-flow-b-a", chunk: "a".repeat(2000) });

    expect(ipcCalls.filter((call) => call.method === "ack")).toEqual([
      {
        channel: "pty",
        method: "ack",
        args: { workspaceId: WS, tabId: "tab-flow-b-a", bytesConsumed: 5000 },
      },
    ]);

    clientA.dispose();
    clientB.dispose();
  });

  it("disposing a PTY client removes listeners without killing the session", () => {
    let received = 0;
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-dispose-no-kill",
      cwd: "/workspace",
      onData: () => {
        received += 1;
      },
      onExit: () => {},
    });

    client.dispose();
    emit("pty", "data", {
      workspaceId: WS,
      tabId: "tab-dispose-no-kill",
      chunk: "after dispose",
    });

    expect(received).toBe(0);
    expect(ipcCalls.some((call) => call.channel === "pty" && call.method === "kill")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PTY exit lifecycle — verifies the renderer-side cleanup that happens AFTER
// the main process emits 'pty:exit'. The previous tests only assert that the
// renderer sent 'pty:kill'; this section closes the loop by simulating the
// exit echo and asserting that onExit fires, listeners stop firing, and a
// subsequent spawn for the same tabId is not deduped against the dead session.
// ---------------------------------------------------------------------------

describe("services/terminal pty-client exit lifecycle", () => {
  beforeEach(resetIpc);

  it("on pty:exit, onExit fires with the exit code and data is no longer delivered", () => {
    let received = "";
    const exits: Array<{ code: number | null }> = [];
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-exit",
      cwd: "/workspace",
      onData: (chunk) => {
        received += chunk;
      },
      onExit: (info) => {
        exits.push(info);
      },
    });

    emit("pty", "data", { workspaceId: WS, tabId: "tab-exit", chunk: "alive" });
    expect(received).toBe("alive");

    emit("pty", "exit", { workspaceId: WS, tabId: "tab-exit", code: 0 });
    expect(exits).toEqual([{ code: 0 }]);

    // Late-arriving data after exit should still flow through onData (the listener
    // is removed by dispose, not by exit) — but a subsequent dispose must not double-fire onExit.
    emit("pty", "data", { workspaceId: WS, tabId: "tab-exit", chunk: "ghost" });
    expect(received).toBe("aliveghost");

    client.dispose();
    emit("pty", "exit", { workspaceId: WS, tabId: "tab-exit", code: 0 });
    expect(exits).toEqual([{ code: 0 }]);
  });

  it("after pty:exit, the next spawnSession for the same tabId is not short-circuited as already-live", async () => {
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-respawn",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {},
    });

    const first = await client.spawn({ cols: 80, rows: 24 });
    expect(first).toEqual({ pid: 1234 });

    // Exit echo from main process — should clear the live-session marker.
    emit("pty", "exit", { workspaceId: WS, tabId: "tab-respawn", code: 0 });

    // Next spawn must hit the IPC again (not be deduped as already-live).
    const beforeCount = ipcCalls.filter((c) => c.channel === "pty" && c.method === "spawn").length;
    const second = await client.spawn({ cols: 80, rows: 24 });
    const afterCount = ipcCalls.filter((c) => c.channel === "pty" && c.method === "spawn").length;

    expect(second).toEqual({ pid: 1234 });
    expect(afterCount - beforeCount).toBe(1);

    client.dispose();
  });

  it("ignores pty:exit destined for a different tabId", () => {
    let exitFired = false;
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-self",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {
        exitFired = true;
      },
    });

    emit("pty", "exit", { workspaceId: WS, tabId: "tab-other", code: 1 });
    expect(exitFired).toBe(false);

    client.dispose();
  });

  it("ignores PTY data and exits destined for a different workspaceId", () => {
    let received = "";
    let exitFired = false;
    const client = createPtyClient({
      workspaceId: WS,
      tabId: "tab-same-id",
      cwd: "/workspace",
      onData: (chunk) => {
        received += chunk;
      },
      onExit: () => {
        exitFired = true;
      },
    });

    emit("pty", "data", { workspaceId: OTHER_WS, tabId: "tab-same-id", chunk: "wrong" });
    emit("pty", "exit", { workspaceId: OTHER_WS, tabId: "tab-same-id", code: 1 });

    expect(received).toBe("");
    expect(exitFired).toBe(false);

    client.dispose();
  });

  it("lets pty:exit mark the matching terminal tab dead synchronously", () => {
    resetStores();
    const terminal = openTerminal({ workspaceId: WS, cwd: "/workspace" });
    const client = createPtyClient({
      workspaceId: WS,
      tabId: terminal.tabId,
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {
        useTabsStore.getState().setTerminalDead(WS, terminal.tabId, true);
      },
    });

    emit("pty", "exit", { workspaceId: WS, tabId: terminal.tabId, code: null });

    const tab = useTabsStore.getState().byWorkspace[WS]?.[terminal.tabId];
    expect(tab?.type).toBe("terminal");
    if (tab?.type === "terminal") expect(tab.props.dead).toBe(true);

    client.dispose();
  });
});

describe("services/terminal controller reopen", () => {
  beforeEach(resetIpc);

  it("reopens with the same tab identity and original cwd without clearing scrollback", async () => {
    const harness = makeTerminalControllerDeps();
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-reopen",
        cwd: "/workspace/original",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();

    await controller.reopen();

    expect(harness.getPtyOptions()).toMatchObject({
      workspaceId: WS,
      tabId: "tab-reopen",
      cwd: "/workspace/original",
    });
    expect(harness.spawnCalls).toEqual([{ cols: 100, rows: 40 }]);
    expect(harness.writes).toEqual([`\r\n${TERMINAL_REOPENED_SEPARATOR}\r\n`]);

    controller.dispose();
  });

  it("surfaces reopen spawn failure so the view can swap to retry copy", async () => {
    const harness = makeTerminalControllerDeps(() => Promise.reject(new Error("agent down")));
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-reopen-fails",
        cwd: "/workspace/original",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();

    await expect(controller.reopen()).rejects.toThrow("agent down");
    expect(harness.writes).toEqual([]);

    controller.dispose();
  });

  it("treats spawn=null (already live) as a no-op so the view does not show failed copy", async () => {
    // spawn returning null signals the session is already live; the controller
    // must not throw so the caller never sets reopenState to "failed".
    const harness = makeTerminalControllerDeps(() => Promise.resolve(null));
    const controller = createTerminalController(
      {
        workspaceId: WS,
        tabId: "tab-reopen-already-live",
        cwd: "/workspace/original",
        container: { clientWidth: 800, clientHeight: 480 } as HTMLElement,
        autoSpawn: false,
      },
      harness.deps,
    );
    await flushTerminalInit();

    // Must resolve without throwing — no failed state propagated to the view.
    await expect(controller.reopen()).resolves.toBeUndefined();
    // No separator written when the session was already live.
    expect(harness.writes).toEqual([]);

    controller.dispose();
  });
});

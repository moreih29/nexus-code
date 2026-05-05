import { beforeEach, describe, expect, it, mock } from "bun:test";

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
const { createPtyClient } = await import("../../../../src/renderer/services/terminal/pty-client");
const { closeGroup } = await import("../../../../src/renderer/state/operations");
const { useLayoutStore } = await import("../../../../src/renderer/state/stores/layout");
const { findLeaf } = await import("../../../../src/renderer/state/stores/layout/helpers");
const { useTabsStore } = await import("../../../../src/renderer/state/stores/tabs");

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

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
      { channel: "pty", method: "kill", args: { tabId: terminal.tabId } },
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
      { channel: "pty", method: "kill", args: { tabId: first.tabId } },
      { channel: "pty", method: "kill", args: { tabId: second.tabId } },
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

    expect(killCalls()).toEqual([{ channel: "pty", method: "kill", args: { tabId: right.tabId } }]);
    const wsTabs = useTabsStore.getState().byWorkspace[WS];
    expect(wsTabs?.[left.tabId]).toBeDefined();
    expect(wsTabs?.[right.tabId]).toBeUndefined();
    expect(wsTabs?.[editor.id]).toBeUndefined();
  });

  it("terminal controller dispose does not kill the PTY session", async () => {
    const controller = createTerminalController({
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
      tabId: "tab-flow-a",
      cwd: "/workspace",
      onData: (chunk) => received.push(chunk),
      onExit: () => {},
    });

    emit("pty", "data", { tabId: "tab-flow-a", chunk: "a".repeat(4999) });
    expect(ipcCalls.filter((call) => call.method === "ack")).toHaveLength(0);

    emit("pty", "data", { tabId: "tab-flow-a", chunk: "b" });

    expect(received.join("").length).toBe(5000);
    expect(ipcCalls).toContainEqual({
      channel: "pty",
      method: "ack",
      args: { tabId: "tab-flow-a", bytesConsumed: 5000 },
    });

    client.dispose();
  });

  it("keeps ACK counters module-private and isolated by tabId", () => {
    const clientA = createPtyClient({
      tabId: "tab-flow-b-a",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {},
    });
    const clientB = createPtyClient({
      tabId: "tab-flow-b-b",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {},
    });

    emit("pty", "data", { tabId: "tab-flow-b-a", chunk: "a".repeat(3000) });
    emit("pty", "data", { tabId: "tab-flow-b-b", chunk: "b".repeat(3000) });
    emit("pty", "data", { tabId: "tab-flow-b-a", chunk: "a".repeat(2000) });

    expect(ipcCalls.filter((call) => call.method === "ack")).toEqual([
      {
        channel: "pty",
        method: "ack",
        args: { tabId: "tab-flow-b-a", bytesConsumed: 5000 },
      },
    ]);

    clientA.dispose();
    clientB.dispose();
  });

  it("disposing a PTY client removes listeners without killing the session", () => {
    let received = 0;
    const client = createPtyClient({
      tabId: "tab-dispose-no-kill",
      cwd: "/workspace",
      onData: () => {
        received += 1;
      },
      onExit: () => {},
    });

    client.dispose();
    emit("pty", "data", { tabId: "tab-dispose-no-kill", chunk: "after dispose" });

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
      tabId: "tab-exit",
      cwd: "/workspace",
      onData: (chunk) => {
        received += chunk;
      },
      onExit: (info) => {
        exits.push(info);
      },
    });

    emit("pty", "data", { tabId: "tab-exit", chunk: "alive" });
    expect(received).toBe("alive");

    emit("pty", "exit", { tabId: "tab-exit", code: 0 });
    expect(exits).toEqual([{ code: 0 }]);

    // Late-arriving data after exit should still flow through onData (the listener
    // is removed by dispose, not by exit) — but a subsequent dispose must not double-fire onExit.
    emit("pty", "data", { tabId: "tab-exit", chunk: "ghost" });
    expect(received).toBe("aliveghost");

    client.dispose();
    emit("pty", "exit", { tabId: "tab-exit", code: 0 });
    expect(exits).toEqual([{ code: 0 }]);
  });

  it("after pty:exit, the next spawnSession for the same tabId is not short-circuited as already-live", async () => {
    const client = createPtyClient({
      tabId: "tab-respawn",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {},
    });

    const first = await client.spawn({ cols: 80, rows: 24 });
    expect(first).toEqual({ pid: 1234 });

    // Exit echo from main process — should clear the live-session marker.
    emit("pty", "exit", { tabId: "tab-respawn", code: 0 });

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
      tabId: "tab-self",
      cwd: "/workspace",
      onData: () => {},
      onExit: () => {
        exitFired = true;
      },
    });

    emit("pty", "exit", { tabId: "tab-other", code: 1 });
    expect(exitFired).toBe(false);

    client.dispose();
  });
});

import { describe, expect, mock, test } from "bun:test";
import type { ITerminalOptions } from "@xterm/xterm";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  createTerminalService,
  type TerminalDataEvent,
  type TerminalInputEvent,
  type TerminalServiceShellBridgeLike,
  type TerminalServiceShellDependencies,
  type TerminalServiceTerminalCreateOptions,
  type TerminalServiceTerminalLike,
  type TerminalServiceXtermDependencies,
  type TerminalTabClosedEvent,
  type TerminalTabExitedEvent,
} from "./terminal-service";

const alphaWorkspaceId = "ws_alpha" as WorkspaceId;
const betaWorkspaceId = "ws_beta" as WorkspaceId;

class FakeTerminal implements TerminalServiceTerminalLike {
  public readonly mountedHosts: HTMLElement[] = [];
  public readonly writes: string[] = [];
  public fitCount = 0;

  public constructor(public readonly options: TerminalServiceTerminalCreateOptions) {}

  public readonly mount = mock((host: HTMLElement) => {
    this.mountedHosts.push(host);
    return true;
  });

  public readonly detach = mock(() => {
    // no-op
  });

  public readonly fit = mock(() => {
    this.fitCount += 1;
  });

  public readonly focus = mock(() => {
    // no-op
  });

  public readonly write = mock((data: string) => {
    this.writes.push(data);
  });

  public readonly dispose = mock(() => {
    // no-op
  });
}

class FakeXtermDependencies implements TerminalServiceXtermDependencies {
  public readonly terminalOptions: Array<ITerminalOptions | undefined> = [];
  public readonly terminals: FakeTerminal[] = [];

  public readonly createTerminal = mock((options: TerminalServiceTerminalCreateOptions) => {
    this.terminalOptions.push(options.terminalOptions);
    const terminal = new FakeTerminal(options);
    this.terminals.push(terminal);
    return terminal;
  });
}

class FakeShellBridge implements TerminalServiceShellBridgeLike {
  public readonly openedListeners = new Set<Parameters<TerminalServiceShellBridgeLike["onOpened"]>[0]>();
  public readonly stdoutListeners = new Set<Parameters<TerminalServiceShellBridgeLike["onStdout"]>[0]>();
  public readonly exitedListeners = new Set<Parameters<TerminalServiceShellBridgeLike["onExited"]>[0]>();
  public readonly openCommands: Parameters<TerminalServiceShellBridgeLike["open"]>[0][] = [];
  public readonly inputCommands: Parameters<TerminalServiceShellBridgeLike["input"]>[0][] = [];
  public readonly resizeCommands: Parameters<TerminalServiceShellBridgeLike["resize"]>[0][] = [];
  public readonly closeCommands: Parameters<TerminalServiceShellBridgeLike["close"]>[0][] = [];
  private openSequence = 0;

  public readonly open = mock(async (command: Parameters<TerminalServiceShellBridgeLike["open"]>[0]) => {
    this.openCommands.push(command);
    this.openSequence += 1;
    const event = {
      type: "terminal/opened" as const,
      tabId: `tt_${command.workspaceId}_${this.openSequence}`,
      workspaceId: command.workspaceId,
      pid: 20_000 + this.openSequence,
    };
    this.emitOpened(event);
    return event;
  });

  public readonly input = mock(async (command: Parameters<TerminalServiceShellBridgeLike["input"]>[0]) => {
    this.inputCommands.push(command);
  });

  public readonly resize = mock(async (command: Parameters<TerminalServiceShellBridgeLike["resize"]>[0]) => {
    this.resizeCommands.push(command);
  });

  public readonly close = mock(async (command: Parameters<TerminalServiceShellBridgeLike["close"]>[0]) => {
    this.closeCommands.push(command);
    return null;
  });

  public onOpened(listener: Parameters<TerminalServiceShellBridgeLike["onOpened"]>[0]) {
    this.openedListeners.add(listener);
    return {
      dispose: () => {
        this.openedListeners.delete(listener);
      },
    };
  }

  public onStdout(listener: Parameters<TerminalServiceShellBridgeLike["onStdout"]>[0]) {
    this.stdoutListeners.add(listener);
    return {
      dispose: () => {
        this.stdoutListeners.delete(listener);
      },
    };
  }

  public onExited(listener: Parameters<TerminalServiceShellBridgeLike["onExited"]>[0]) {
    this.exitedListeners.add(listener);
    return {
      dispose: () => {
        this.exitedListeners.delete(listener);
      },
    };
  }

  public readonly dispose = mock(() => {
    // no-op
  });

  public emitOpened(event: Parameters<Parameters<TerminalServiceShellBridgeLike["onOpened"]>[0]>[0]): void {
    for (const listener of this.openedListeners) {
      listener(event);
    }
  }

  public emitStdout(event: Parameters<Parameters<TerminalServiceShellBridgeLike["onStdout"]>[0]>[0]): void {
    for (const listener of this.stdoutListeners) {
      listener(event);
    }
  }
}

class FakeShellDependencies implements TerminalServiceShellDependencies {
  public readonly bridges: FakeShellBridge[] = [];

  public readonly createBridge = mock(() => {
    const bridge = new FakeShellBridge();
    this.bridges.push(bridge);
    return bridge;
  });
}

function createHost(): HTMLElement {
  return {} as HTMLElement;
}

describe("ITerminalService", () => {
  test("creates tabs and preserves active tabs by workspace", () => {
    const store = createTerminalService();

    const alphaOne = store.getState().createTab({
      id: "terminal_alpha_one",
      title: "Alpha 1",
      workspaceId: alphaWorkspaceId,
      cwd: "/tmp/alpha",
      createdAt: "2026-04-28T00:00:00.000Z",
    });
    const alphaTwo = store.getState().createTab({
      id: "terminal_alpha_two",
      title: "Alpha 2",
      workspaceId: alphaWorkspaceId,
      createdAt: "2026-04-28T00:01:00.000Z",
    });
    const betaOne = store.getState().createTab({
      id: "terminal_beta_one",
      title: "Beta 1",
      workspaceId: betaWorkspaceId,
      createdAt: "2026-04-28T00:02:00.000Z",
    });

    expect(store.getState().getTabs(alphaWorkspaceId).map((tab) => tab.id)).toEqual([
      alphaOne.id,
      alphaTwo.id,
    ]);
    expect(store.getState().getTabs(betaWorkspaceId).map((tab) => tab.id)).toEqual([betaOne.id]);
    expect(store.getState().getActiveTab()?.id).toBe(betaOne.id);

    store.getState().setActiveWorkspace(alphaWorkspaceId);
    expect(store.getState().getActiveTab()?.id).toBe(alphaTwo.id);

    store.getState().setActiveTab(alphaOne.id);
    store.getState().setActiveWorkspace(betaWorkspaceId);
    expect(store.getState().getActiveTab()?.id).toBe(betaOne.id);

    store.getState().setActiveWorkspace(alphaWorkspaceId);
    expect(store.getState().getActiveTab()?.id).toBe(alphaOne.id);
  });

  test("sends PTY input through service callbacks for live tabs only", () => {
    const store = createTerminalService();
    const inputEvents: TerminalInputEvent[] = [];
    const unsubscribe = store.getState().onInput((event) => {
      inputEvents.push(event);
    });

    expect(store.getState().sendInput("missing", "ls\n")).toBe(false);

    store.getState().createTab({
      id: "terminal_input",
      workspaceId: alphaWorkspaceId,
      createdAt: "2026-04-28T00:00:00.000Z",
    });

    expect(store.getState().sendInput("terminal_input", "ls\n")).toBe(true);
    expect(inputEvents).toHaveLength(1);
    expect(inputEvents[0]).toMatchObject({
      tabId: "terminal_input",
      workspaceId: alphaWorkspaceId,
      data: "ls\n",
    });

    unsubscribe();
    expect(store.getState().sendInput("terminal_input", "pwd\n")).toBe(true);
    expect(inputEvents).toHaveLength(1);

    store.getState().markTabExited({
      tabId: "terminal_input",
      reason: "process-exit",
      exitCode: 0,
      exitedAt: "2026-04-28T00:01:00.000Z",
    });
    expect(store.getState().sendInput("terminal_input", "echo nope\n")).toBe(false);
  });

  test("receives PTY output data, stores event metadata, and notifies subscribers", () => {
    const store = createTerminalService();
    const dataEvents: TerminalDataEvent[] = [];
    const unsubscribe = store.getState().onData((event) => {
      dataEvents.push(event);
    });

    expect(store.getState().receiveData({ tabId: "missing", data: "ignored\n" })).toBe(false);

    store.getState().createTab({
      id: "terminal_output",
      workspaceId: alphaWorkspaceId,
      status: "connecting",
      createdAt: "2026-04-28T00:00:00.000Z",
    });

    expect(
      store.getState().receiveData({
        tabId: "terminal_output",
        seq: 1,
        data: "ready\n",
        receivedAt: "2026-04-28T00:00:01.000Z",
      }),
    ).toBe(true);

    expect(dataEvents).toEqual([
      {
        tabId: "terminal_output",
        workspaceId: alphaWorkspaceId,
        seq: 1,
        data: "ready\n",
        receivedAt: "2026-04-28T00:00:01.000Z",
      },
    ]);
    expect(store.getState().dataEvents).toEqual(dataEvents);
    expect(store.getState().lastDataByTabId.terminal_output).toBe("ready\n");
    expect(store.getState().getActiveTab()?.status).toBe("running");

    unsubscribe();
    store.getState().receiveData({ tabId: "terminal_output", data: "after unsubscribe\n" });
    expect(dataEvents).toHaveLength(1);
  });

  test("marks PTY exits without deleting the tab until closeTab", () => {
    const store = createTerminalService();
    const exitEvents: TerminalTabExitedEvent[] = [];
    const unsubscribe = store.getState().onTabExited((event) => {
      exitEvents.push(event);
    });

    store.getState().createTab({
      id: "terminal_exit",
      workspaceId: alphaWorkspaceId,
      status: "running",
      createdAt: "2026-04-28T00:00:00.000Z",
    });

    expect(
      store.getState().markTabExited({
        tabId: "terminal_exit",
        reason: "process-exit",
        exitCode: 2,
        exitedAt: "2026-04-28T00:01:00.000Z",
      }),
    ).toBe(true);

    expect(store.getState().getActiveTab()).toMatchObject({
      id: "terminal_exit",
      status: "exited",
      exitCode: 2,
      exitedAt: "2026-04-28T00:01:00.000Z",
    });
    expect(exitEvents).toEqual([
      {
        tabId: "terminal_exit",
        workspaceId: alphaWorkspaceId,
        reason: "process-exit",
        exitCode: 2,
        exitedAt: "2026-04-28T00:01:00.000Z",
      },
    ]);
    expect(store.getState().getTabs()).toHaveLength(1);

    unsubscribe();
    expect(store.getState().markTabExited({ tabId: "missing", reason: "process-exit", exitCode: 0 })).toBe(false);
    store.getState().closeTab("terminal_exit");
    expect(store.getState().getTabs()).toEqual([]);
  });

  test("closes tabs, leaves panel view persistence outside the service, and recreates after last close", () => {
    const store = createTerminalService();
    const closedEvents: TerminalTabClosedEvent[] = [];
    const unsubscribe = store.getState().onTabClosed((event) => {
      closedEvents.push(event);
    });

    store.getState().createTab({
      id: "terminal_close",
      workspaceId: alphaWorkspaceId,
      createdAt: "2026-04-28T00:00:00.000Z",
    });

    expect(store.getState().closeTab("terminal_close", "user-close")).toBe(true);
    expect(store.getState().tabs).toEqual([]);
    expect(store.getState().activeTabId).toBeNull();
    expect(closedEvents).toEqual([
      {
        tabId: "terminal_close",
        workspaceId: alphaWorkspaceId,
        reason: "user-close",
      },
    ]);

    const snapshot = store.getState().getSnapshot();
    expect("expanded" in snapshot).toBe(false);
    expect("height" in snapshot).toBe(false);
    expect("position" in snapshot).toBe(false);
    expect("activeViewId" in snapshot).toBe(false);

    store.getState().createTab({
      id: "terminal_recreated",
      workspaceId: alphaWorkspaceId,
      createdAt: "2026-04-28T00:01:00.000Z",
    });
    expect(store.getState().getActiveTab()?.id).toBe("terminal_recreated");

    unsubscribe();
    expect(store.getState().closeTab("missing")).toBe(false);
  });

  test("tracks shell mount lifecycle and disposes service listeners", () => {
    const store = createTerminalService();
    const inputEvents: TerminalInputEvent[] = [];

    expect(store.getState().getLifecycleSnapshot()).toEqual({ shellMounted: false });

    const firstUnmount = store.getState().mountShell();
    const secondUnmount = store.getState().mountShell();
    expect(store.getState().getLifecycleSnapshot()).toEqual({ shellMounted: true });

    firstUnmount();
    firstUnmount();
    expect(store.getState().getLifecycleSnapshot()).toEqual({ shellMounted: true });

    secondUnmount();
    expect(store.getState().getLifecycleSnapshot()).toEqual({ shellMounted: false });

    store.getState().unmountShell();
    expect(store.getState().getLifecycleSnapshot()).toEqual({ shellMounted: false });

    store.getState().onInput((event) => {
      inputEvents.push(event);
    });
    store.getState().createTab({
      id: "terminal_lifecycle",
      workspaceId: alphaWorkspaceId,
      createdAt: "2026-04-28T00:00:00.000Z",
    });

    const shellUnmount = store.getState().mountShell();
    store.getState().dispose();
    expect(store.getState().getLifecycleSnapshot()).toEqual({ shellMounted: false });
    expect(store.getState().sendInput("terminal_lifecycle", "pwd\n")).toBe(true);
    expect(inputEvents).toEqual([]);

    shellUnmount();
    expect(store.getState().getLifecycleSnapshot()).toEqual({ shellMounted: false });
  });

  test("mountShell bridges PTY open, output, input, resize, and close commands", async () => {
    const xtermDependencies = new FakeXtermDependencies();
    const shellDependencies = new FakeShellDependencies();
    const store = createTerminalService({}, xtermDependencies, shellDependencies);
    const shellUnmount = store.getState().mountShell();
    const bridge = shellDependencies.bridges[0]!;

    const tabId = await store.getState().requestNewTab(alphaWorkspaceId);

    expect(shellDependencies.createBridge.mock.calls).toHaveLength(1);
    expect(bridge.openCommands).toEqual([
      {
        type: "terminal/open",
        workspaceId: alphaWorkspaceId,
        cols: 120,
        rows: 30,
      },
    ]);
    expect(store.getState().getActiveTab(alphaWorkspaceId)).toMatchObject({
      id: tabId,
      pid: 20_001,
      status: "running",
    });

    bridge.emitStdout({
      type: "terminal/stdout",
      tabId,
      seq: 1,
      data: "hello from pty\n",
    });
    expect(store.getState().lastDataByTabId[tabId]).toBe("hello from pty\n");

    store.getState().attachToHost(tabId, createHost());
    xtermDependencies.terminals[0]!.options.onInput("pwd\n");
    xtermDependencies.terminals[0]!.options.onResize({ cols: 100, rows: 40 });

    expect(bridge.inputCommands).toEqual([
      {
        type: "terminal/input",
        tabId,
        data: "pwd\n",
      },
    ]);
    expect(bridge.resizeCommands).toEqual([
      {
        type: "terminal/resize",
        tabId,
        cols: 100,
        rows: 40,
      },
    ]);

    expect(store.getState().closeTab(tabId)).toBe(true);
    expect(bridge.closeCommands).toEqual([
      {
        type: "terminal/close",
        tabId,
        reason: "user-close",
      },
    ]);

    shellUnmount();
    expect(bridge.dispose.mock.calls).toHaveLength(1);
    expect(store.getState().getLifecycleSnapshot()).toEqual({ shellMounted: false });
  });

  test("attaches xterm sessions to hosts idempotently and replays buffered data", () => {
    const xtermDependencies = new FakeXtermDependencies();
    const store = createTerminalService({}, xtermDependencies);
    const host = createHost();

    store.getState().createTab({
      id: "terminal_attach",
      workspaceId: alphaWorkspaceId,
      createdAt: "2026-04-28T00:00:00.000Z",
    });
    store.getState().receiveData({
      tabId: "terminal_attach",
      data: "before attach\n",
      receivedAt: "2026-04-28T00:00:01.000Z",
    });

    const firstDetach = store.getState().attachToHost("terminal_attach", host, { focus: true });
    const secondDetach = store.getState().attachToHost("terminal_attach", host, { focus: true });
    const terminal = xtermDependencies.terminals[0]!;

    expect(xtermDependencies.createTerminal.mock.calls).toHaveLength(1);
    expect(terminal.mount.mock.calls).toHaveLength(1);
    expect(terminal.fit.mock.calls).toHaveLength(1);
    expect(terminal.focus.mock.calls).toHaveLength(2);
    expect(terminal.writes).toEqual(["before attach\n"]);
    expect(store.getState().getMountedHost("terminal_attach")).toBe(host);

    store.getState().receiveData({
      tabId: "terminal_attach",
      data: "after attach\n",
      receivedAt: "2026-04-28T00:00:02.000Z",
    });
    expect(terminal.writes).toEqual(["before attach\n", "after attach\n"]);

    secondDetach();
    expect(store.getState().getMountedHost("terminal_attach")).toBeNull();
    expect(terminal.detach.mock.calls).toHaveLength(1);
    secondDetach();
    expect(terminal.dispose.mock.calls).toHaveLength(0);

    firstDetach();
    expect(store.getState().getMountedHost("terminal_attach")).toBeNull();
    expect(terminal.dispose.mock.calls).toHaveLength(0);
  });

  test("reopens an existing xterm session on host change and disposes only on closeTab", () => {
    const xtermDependencies = new FakeXtermDependencies();
    const store = createTerminalService({}, xtermDependencies);
    const firstHost = createHost();
    const secondHost = createHost();

    store.getState().createTab({
      id: "terminal_move",
      workspaceId: alphaWorkspaceId,
      createdAt: "2026-04-28T00:00:00.000Z",
    });

    store.getState().attachToHost("terminal_move", firstHost);
    const terminal = xtermDependencies.terminals[0]!;

    store.getState().detachFromHost("terminal_move");
    store.getState().detachFromHost("terminal_move");
    store.getState().dispose();
    store.getState().markTabExited({
      tabId: "terminal_move",
      reason: "process-exit",
      exitCode: 0,
      exitedAt: "2026-04-28T00:01:00.000Z",
    });

    expect(terminal.dispose.mock.calls).toHaveLength(0);
    expect(store.getState().getMountedHost("terminal_move")).toBeNull();

    store.getState().attachToHost("terminal_move", secondHost);

    expect(xtermDependencies.terminals).toHaveLength(1);
    expect(terminal.mountedHosts).toEqual([firstHost, secondHost]);
    expect(terminal.mount.mock.calls).toHaveLength(2);
    expect(store.getState().getMountedHost("terminal_move")).toBe(secondHost);

    expect(store.getState().closeTab("terminal_move")).toBe(true);
    expect(terminal.dispose.mock.calls).toHaveLength(1);
    expect(store.getState().getMountedHost("terminal_move")).toBeNull();

    store.getState().detachFromHost("terminal_move");
    expect(terminal.dispose.mock.calls).toHaveLength(1);
    expect(store.getState().closeTab("terminal_move")).toBe(false);
    expect(terminal.dispose.mock.calls).toHaveLength(1);
  });

  test("requests new tabs and focuses mounted sessions through the service", async () => {
    const xtermDependencies = new FakeXtermDependencies();
    const store = createTerminalService({}, xtermDependencies);
    const host = createHost();

    const tabId = await store.getState().requestNewTab(alphaWorkspaceId);

    expect(tabId).toMatch(/^terminal_request_ws_alpha_/);
    expect(store.getState().getActiveTab(alphaWorkspaceId)).toMatchObject({
      id: tabId,
      title: "Terminal 1",
      workspaceId: alphaWorkspaceId,
    });
    expect(store.getState().focusSession(tabId)).toBe(false);
    expect(store.getState().focusSession("missing")).toBe(false);

    store.getState().attachToHost(tabId, host);
    expect(store.getState().focusSession(tabId)).toBe(true);
    expect(xtermDependencies.terminals[0]!.fit.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(xtermDependencies.terminals[0]!.focus.mock.calls).toHaveLength(1);

    store.getState().detachFromHost(tabId);
    expect(store.getState().focusSession(tabId)).toBe(false);
  });

  test("preserves existing terminal skeleton compatibility wrappers", () => {
    const store = createTerminalService();

    const firstTab = store.getState().createTerminal({
      id: "terminal_one",
      title: "Shell",
      workspaceId: alphaWorkspaceId,
      cwd: "/tmp/project",
      createdAt: "2026-04-28T00:00:00.000Z",
    });
    store.getState().createTerminal({ id: "terminal_two", createdAt: "2026-04-28T00:01:00.000Z" });
    store.getState().activateTerminal(firstTab.id);
    store.getState().setTerminalStatus(firstTab.id, "running");

    expect(store.getState().getActiveTerminal()).toMatchObject({
      id: "terminal_one",
      status: "running",
      cwd: "/tmp/project",
    });

    store.getState().closeTerminal(firstTab.id);
    expect(store.getState().activeTabId).toBe("terminal_two");
  });
});

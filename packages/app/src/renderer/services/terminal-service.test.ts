import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  createTerminalService,
  type TerminalDataEvent,
  type TerminalInputEvent,
  type TerminalTabClosedEvent,
  type TerminalTabExitedEvent,
} from "./terminal-service";

const alphaWorkspaceId = "ws_alpha" as WorkspaceId;
const betaWorkspaceId = "ws_beta" as WorkspaceId;

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

import type { ITerminalOptions } from "@xterm/xterm";
import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  TerminalCloseCommand,
  TerminalCloseReason,
  TerminalExitedEvent,
  TerminalExitedReason,
  TerminalInputCommand,
  TerminalOpenCommand,
  TerminalOpenedEvent,
  TerminalResizeCommand,
  TerminalStdoutChunk,
} from "../../../../shared/src/contracts/terminal/terminal-ipc";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { PreloadTerminalBridgeTransport } from "../adapters/preload-terminal-bridge-transport";
import { TerminalBridge, type TerminalBridgeDisposable } from "../terminal/terminal-bridge";
import { XtermView, type XtermResizeEvent } from "../terminal/xterm-view";

export type TerminalTabId = string;
export type TerminalTabStatus = "idle" | "connecting" | "running" | "exited";

export interface TerminalTab {
  id: TerminalTabId;
  title: string;
  workspaceId: WorkspaceId | null;
  shell: string | null;
  cwd: string | null;
  status: TerminalTabStatus;
  createdAt: string;
  pid: number | null;
  exitCode: number | null;
  exitedAt: string | null;
}

export interface CreateTerminalInput {
  id: TerminalTabId;
  title?: string;
  workspaceId?: WorkspaceId | null;
  shell?: string | null;
  cwd?: string | null;
  status?: TerminalTabStatus;
  createdAt?: string;
  pid?: number | null;
  exitCode?: number | null;
  exitedAt?: string | null;
  activate?: boolean;
}

export interface TerminalDataInput {
  tabId: TerminalTabId;
  data: string;
  seq?: number | null;
  receivedAt?: string;
  mainBufferDroppedBytes?: number;
}

export interface TerminalDataEvent {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId | null;
  seq: number | null;
  data: string;
  receivedAt: string;
  mainBufferDroppedBytes?: number;
}

export interface TerminalTabExitInput {
  tabId: TerminalTabId;
  workspaceId?: WorkspaceId | null;
  reason: TerminalExitedReason;
  exitCode: number | null;
  exitedAt?: string;
}

export interface TerminalTabExitedEvent {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId | null;
  reason: TerminalExitedReason;
  exitCode: number | null;
  exitedAt: string;
}

export interface TerminalInputEvent {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId | null;
  data: string;
  sentAt: string;
}

export interface TerminalTabClosedEvent {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId | null;
  reason: TerminalCloseReason;
}

export type TerminalDataListener = (event: TerminalDataEvent) => void;
export type TerminalTabExitedListener = (event: TerminalTabExitedEvent) => void;
export type TerminalInputListener = (event: TerminalInputEvent) => void;
export type TerminalTabClosedListener = (event: TerminalTabClosedEvent) => void;
export type TerminalServiceUnsubscribe = () => void;

export interface AttachTerminalHostOptions {
  focus?: boolean;
}

export interface TerminalServiceTerminalCreateOptions {
  terminalOptions?: ITerminalOptions;
  onInput(data: string): void;
  onResize(size: XtermResizeEvent): void;
}

export interface TerminalServiceTerminalLike {
  mount(parent: HTMLElement): boolean;
  detach?(): void;
  fit?(): void;
  focus(): void;
  write(data: string): void;
  dispose(): void;
}

export interface TerminalServiceXtermDependencies {
  createTerminal(options: TerminalServiceTerminalCreateOptions): TerminalServiceTerminalLike;
}

export interface TerminalServiceShellBridgeLike {
  open(command: TerminalOpenCommand): Promise<TerminalOpenedEvent>;
  input(command: TerminalInputCommand): Promise<void>;
  resize(command: TerminalResizeCommand): Promise<void>;
  close(command: TerminalCloseCommand): Promise<unknown>;
  onOpened(listener: (event: TerminalOpenedEvent) => void): TerminalBridgeDisposable;
  onStdout(listener: (event: TerminalStdoutChunk) => void): TerminalBridgeDisposable;
  onExited(listener: (event: TerminalExitedEvent) => void): TerminalBridgeDisposable;
  dispose(): void;
}

export interface TerminalServiceShellDependencies {
  createBridge(): TerminalServiceShellBridgeLike | null;
}

export type TerminalServiceActiveTabByWorkspaceId = Record<string, TerminalTabId | null>;
export type TerminalServiceLastDataByTabId = Record<TerminalTabId, string>;

export interface TerminalServiceLifecycleSnapshot {
  shellMounted: boolean;
}

export interface TerminalServiceSnapshot {
  tabs: TerminalTab[];
  activeTabId: TerminalTabId | null;
  activeWorkspaceId: WorkspaceId | null;
  activeTabIdByWorkspaceId: TerminalServiceActiveTabByWorkspaceId;
  dataEvents: TerminalDataEvent[];
  exitEvents: TerminalTabExitedEvent[];
  lastDataByTabId: TerminalServiceLastDataByTabId;
}

/**
 * Stores PTY tab metadata, lifecycle events, and renderer xterm instance ownership.
 * Bottom panel view selection, placement, expansion, and height persistence stay in IBottomPanelService.
 * PTY process bridge mounting stays separate via mountShell/unmountShell.
 */
export interface ITerminalService extends TerminalServiceSnapshot {
  createTab(input: CreateTerminalInput): TerminalTab;
  closeTab(tabId: TerminalTabId, reason?: TerminalCloseReason): boolean;
  getTabs(workspaceId?: WorkspaceId | null): TerminalTab[];
  getActiveTab(workspaceId?: WorkspaceId | null): TerminalTab | null;
  setActiveTab(tabId: TerminalTabId): boolean;
  setActiveWorkspace(workspaceId: WorkspaceId | null): void;
  sendInput(tabId: TerminalTabId, data: string): boolean;
  receiveData(input: TerminalDataInput): boolean;
  markTabExited(input: TerminalTabExitInput): boolean;
  setTerminalStatus(tabId: TerminalTabId, status: TerminalTabStatus): void;
  getSnapshot(): TerminalServiceSnapshot;
  onData(listener: TerminalDataListener): TerminalServiceUnsubscribe;
  onTabExited(listener: TerminalTabExitedListener): TerminalServiceUnsubscribe;
  onInput(listener: TerminalInputListener): TerminalServiceUnsubscribe;
  onTabClosed(listener: TerminalTabClosedListener): TerminalServiceUnsubscribe;
  mountShell(): TerminalServiceUnsubscribe;
  unmountShell(): void;
  attachToHost(
    sessionId: TerminalTabId,
    host: HTMLElement,
    opts?: AttachTerminalHostOptions,
  ): TerminalServiceUnsubscribe;
  detachFromHost(sessionId: TerminalTabId): void;
  focusSession(sessionId: TerminalTabId): boolean;
  requestNewTab(workspaceId: WorkspaceId): Promise<TerminalTabId>;
  getMountedHost(sessionId: TerminalTabId): HTMLElement | null;
  dispose(): void;
  getLifecycleSnapshot(): TerminalServiceLifecycleSnapshot;
  createTerminal(input: CreateTerminalInput): TerminalTab;
  closeTerminal(tabId: TerminalTabId): void;
  activateTerminal(tabId: TerminalTabId): void;
  getActiveTerminal(): TerminalTab | null;
}

export type TerminalServiceStore = StoreApi<ITerminalService>;
export type TerminalServiceState = TerminalServiceSnapshot;

const NULL_WORKSPACE_KEY = "__nexus_terminal_null_workspace__";
const DEFAULT_CLOSE_REASON: TerminalCloseReason = "user-close";
const REQUESTED_TAB_ID_PREFIX = "terminal_request";
const DEFAULT_TERMINAL_OPEN_COLS = 120;
const DEFAULT_TERMINAL_OPEN_ROWS = 30;

const DEFAULT_TERMINAL_STATE: TerminalServiceState = {
  tabs: [],
  activeTabId: null,
  activeWorkspaceId: null,
  activeTabIdByWorkspaceId: {},
  dataEvents: [],
  exitEvents: [],
  lastDataByTabId: {},
};

class TerminalServiceXtermViewAdapter implements TerminalServiceTerminalLike {
  private readonly view: XtermView;

  public constructor(options: TerminalServiceTerminalCreateOptions) {
    this.view = new XtermView({
      terminalOptions: options.terminalOptions,
      onInput: options.onInput,
      onResize: options.onResize,
    });
  }

  public mount(parent: HTMLElement): boolean {
    return this.view.mount(parent);
  }

  public detach(): void {
    this.view.detach();
  }

  public fit(): void {
    this.view.fit();
  }

  public focus(): void {
    this.view.focus();
  }

  public write(data: string): void {
    this.view.write(data);
  }

  public dispose(): void {
    this.view.unmount();
  }
}

const DEFAULT_XTERM_DEPENDENCIES: TerminalServiceXtermDependencies = {
  createTerminal: (options) => new TerminalServiceXtermViewAdapter(options),
};
const DEFAULT_SHELL_DEPENDENCIES: TerminalServiceShellDependencies = {
  createBridge: () => {
    const rendererWindow = globalThis.window as (Window & typeof globalThis) | undefined;
    if (!rendererWindow?.nexusTerminal) {
      return null;
    }

    return new TerminalBridge(new PreloadTerminalBridgeTransport());
  },
};
const noopUnsubscribe: TerminalServiceUnsubscribe = () => {
  // no-op
};

interface TerminalRenderSession {
  terminal: TerminalServiceTerminalLike;
  mountedHost: HTMLElement | null;
  writtenDataEventCount: number;
}

interface TerminalShellMount {
  bridge: TerminalServiceShellBridgeLike;
  subscriptions: Array<TerminalBridgeDisposable | TerminalServiceUnsubscribe>;
}

export function createTerminalService(
  initialState: Partial<TerminalServiceState> = {},
  xtermDependencies: TerminalServiceXtermDependencies = DEFAULT_XTERM_DEPENDENCIES,
  shellDependencies: TerminalServiceShellDependencies = DEFAULT_SHELL_DEPENDENCIES,
): TerminalServiceStore {
  const initial = normalizeInitialState(initialState);
  const dataListeners = new Set<TerminalDataListener>();
  const tabExitedListeners = new Set<TerminalTabExitedListener>();
  const inputListeners = new Set<TerminalInputListener>();
  const tabClosedListeners = new Set<TerminalTabClosedListener>();
  const renderSessionsById = new Map<TerminalTabId, TerminalRenderSession>();
  let shellMountCount = 0;
  let shellMount: TerminalShellMount | null = null;
  let requestedTabSequence = initial.tabs.length;
  let getState: () => ITerminalService = () => {
    throw new Error("Terminal service state is not initialized.");
  };

  return createStore<ITerminalService>((set, get) => {
    getState = get;

    return {
      ...initial,
    createTab(input) {
      const existingTab = get().tabs.find((tab) => tab.id === input.id) ?? null;
      const workspaceId = input.workspaceId === undefined
        ? get().activeWorkspaceId
        : input.workspaceId;
      const tab: TerminalTab = {
        id: input.id,
        title: input.title ?? existingTab?.title ?? "Terminal",
        workspaceId: workspaceId ?? null,
        shell: input.shell ?? existingTab?.shell ?? null,
        cwd: input.cwd ?? existingTab?.cwd ?? null,
        status: input.status ?? existingTab?.status ?? "idle",
        createdAt: input.createdAt ?? existingTab?.createdAt ?? new Date().toISOString(),
        pid: input.pid ?? existingTab?.pid ?? null,
        exitCode: input.exitCode ?? existingTab?.exitCode ?? null,
        exitedAt: input.exitedAt ?? existingTab?.exitedAt ?? null,
      };
      const activate = input.activate ?? true;

      set((state) => {
        const tabs = state.tabs.some((existing) => existing.id === tab.id)
          ? state.tabs.map((existing) => existing.id === tab.id ? tab : existing)
          : [...state.tabs, tab];
        const workspaceKey = createWorkspaceKey(tab.workspaceId);
        const activeTabIdByWorkspaceId = { ...state.activeTabIdByWorkspaceId };
        const workspaceActiveTabId = activeTabIdByWorkspaceId[workspaceKey];

        if (
          activate ||
          !workspaceActiveTabId ||
          !tabs.some((candidate) => candidate.id === workspaceActiveTabId)
        ) {
          activeTabIdByWorkspaceId[workspaceKey] = tab.id;
        }

        if (activate || !state.activeTabId) {
          return {
            tabs,
            activeTabId: tab.id,
            activeWorkspaceId: tab.workspaceId,
            activeTabIdByWorkspaceId,
          };
        }

        return {
          tabs,
          activeTabIdByWorkspaceId,
        };
      });

      return cloneTab(tab);
    },
    closeTab(tabId, reason = DEFAULT_CLOSE_REASON) {
      const tab = get().tabs.find((candidate) => candidate.id === tabId) ?? null;
      if (!tab) {
        return false;
      }

      const closedEvent: TerminalTabClosedEvent = {
        tabId,
        workspaceId: tab.workspaceId,
        reason,
      };

      set((state) => {
        const tabs = state.tabs.filter((candidate) => candidate.id !== tabId);
        const activeTabIdByWorkspaceId = { ...state.activeTabIdByWorkspaceId };
        const closedWorkspaceKey = createWorkspaceKey(tab.workspaceId);
        const nextWorkspaceActiveTabId = resolveNextTabIdAfterClose(state.tabs, tabId, tab.workspaceId);

        if (activeTabIdByWorkspaceId[closedWorkspaceKey] === tabId) {
          activeTabIdByWorkspaceId[closedWorkspaceKey] = nextWorkspaceActiveTabId;
        }

        let activeWorkspaceId = state.activeWorkspaceId;
        let activeTabId = state.activeTabId;
        if (state.activeTabId === tabId) {
          activeWorkspaceId = tab.workspaceId;
          activeTabId = nextWorkspaceActiveTabId;
        }

        const lastDataByTabId = { ...state.lastDataByTabId };
        delete lastDataByTabId[tabId];

        return {
          tabs,
          activeTabId,
          activeWorkspaceId,
          activeTabIdByWorkspaceId,
          dataEvents: state.dataEvents.filter((event) => event.tabId !== tabId),
          exitEvents: state.exitEvents.filter((event) => event.tabId !== tabId),
          lastDataByTabId,
        };
      });

      disposeRenderSession(tabId);
      emitToListeners(tabClosedListeners, closedEvent);
      return true;
    },
    getTabs(workspaceId) {
      const tabs = get().tabs;
      return workspaceId === undefined
        ? cloneTabs(tabs)
        : cloneTabs(tabs.filter((tab) => tab.workspaceId === workspaceId));
    },
    getActiveTab(workspaceId) {
      const state = get();
      const activeTabId = workspaceId === undefined
        ? state.activeTabId
        : resolveActiveTabIdForWorkspace(state, workspaceId);

      return cloneNullableTab(state.tabs.find((tab) => tab.id === activeTabId) ?? null);
    },
    setActiveTab(tabId) {
      const tab = get().tabs.find((candidate) => candidate.id === tabId) ?? null;
      if (!tab) {
        return false;
      }

      set((state) => ({
        activeTabId: tab.id,
        activeWorkspaceId: tab.workspaceId,
        activeTabIdByWorkspaceId: {
          ...state.activeTabIdByWorkspaceId,
          [createWorkspaceKey(tab.workspaceId)]: tab.id,
        },
      }));
      return true;
    },
    setActiveWorkspace(workspaceId) {
      set((state) => {
        const activeTabId = resolveActiveTabIdForWorkspace(state, workspaceId);
        return {
          activeWorkspaceId: workspaceId,
          activeTabId,
          activeTabIdByWorkspaceId: {
            ...state.activeTabIdByWorkspaceId,
            [createWorkspaceKey(workspaceId)]: activeTabId,
          },
        };
      });
    },
    sendInput(tabId, data) {
      const tab = get().tabs.find((candidate) => candidate.id === tabId) ?? null;
      if (!tab || tab.status === "exited") {
        return false;
      }

      emitToListeners(inputListeners, {
        tabId,
        workspaceId: tab.workspaceId,
        data,
        sentAt: new Date().toISOString(),
      });
      return true;
    },
    receiveData(input) {
      const tab = get().tabs.find((candidate) => candidate.id === input.tabId) ?? null;
      if (!tab || tab.status === "exited") {
        return false;
      }

      const dataEvent = createDataEvent(tab, input);
      set((state) => ({
        tabs: state.tabs.map((candidate) => candidate.id === input.tabId
          ? { ...candidate, status: candidate.status === "exited" ? candidate.status : "running" }
          : candidate),
        dataEvents: [...state.dataEvents, dataEvent],
        lastDataByTabId: {
          ...state.lastDataByTabId,
          [input.tabId]: input.data,
        },
      }));
      writeDataEventToRenderSession(dataEvent);
      emitToListeners(dataListeners, dataEvent);
      return true;
    },
    markTabExited(input) {
      const tab = get().tabs.find((candidate) => candidate.id === input.tabId) ?? null;
      if (!tab) {
        return false;
      }

      const exitEvent: TerminalTabExitedEvent = {
        tabId: input.tabId,
        workspaceId: input.workspaceId ?? tab.workspaceId,
        reason: input.reason,
        exitCode: input.exitCode,
        exitedAt: input.exitedAt ?? new Date().toISOString(),
      };

      set((state) => ({
        tabs: state.tabs.map((candidate) => candidate.id === input.tabId
          ? {
              ...candidate,
              status: "exited",
              exitCode: input.exitCode,
              exitedAt: exitEvent.exitedAt,
            }
          : candidate),
        exitEvents: [...state.exitEvents, exitEvent],
      }));
      emitToListeners(tabExitedListeners, exitEvent);
      return true;
    },
    setTerminalStatus(tabId, status) {
      set((state) => ({
        tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, status } : tab),
      }));
    },
    getSnapshot() {
      return cloneSnapshot(get());
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },
    onTabExited(listener) {
      tabExitedListeners.add(listener);
      return () => {
        tabExitedListeners.delete(listener);
      };
    },
    onInput(listener) {
      inputListeners.add(listener);
      return () => {
        inputListeners.delete(listener);
      };
    },
    onTabClosed(listener) {
      tabClosedListeners.add(listener);
      return () => {
        tabClosedListeners.delete(listener);
      };
    },
    mountShell() {
      if (shellMountCount === 0) {
        startShellBridge();
      }
      shellMountCount += 1;
      let mounted = true;

      return () => {
        if (!mounted) {
          return;
        }

        mounted = false;
        get().unmountShell();
      };
    },
    unmountShell() {
      shellMountCount = Math.max(0, shellMountCount - 1);
      if (shellMountCount === 0) {
        stopShellBridge();
      }
    },
    attachToHost(sessionId, host, opts = {}) {
      const tab = get().tabs.find((candidate) => candidate.id === sessionId) ?? null;
      if (!tab) {
        return noopUnsubscribe;
      }

      const renderSession = ensureRenderSession(sessionId);
      if (renderSession.mountedHost !== host) {
        if (!renderSession.terminal.mount(host)) {
          return noopUnsubscribe;
        }
        renderSession.mountedHost = host;
      } else {
        renderSession.terminal.fit?.();
      }

      replayPendingDataEvents(renderSession, sessionId, get().dataEvents);

      if (opts.focus === true) {
        renderSession.terminal.focus();
      }

      let attached = true;
      return () => {
        if (!attached) {
          return;
        }

        attached = false;
        const latestRenderSession = renderSessionsById.get(sessionId);
        if (latestRenderSession?.mountedHost === host) {
          latestRenderSession.mountedHost = null;
          latestRenderSession.terminal.detach?.();
        }
      };
    },
    detachFromHost(sessionId) {
      const renderSession = renderSessionsById.get(sessionId);
      if (!renderSession) {
        return;
      }

      renderSession.mountedHost = null;
      renderSession.terminal.detach?.();
    },
    focusSession(sessionId) {
      const renderSession = renderSessionsById.get(sessionId);
      if (!renderSession?.mountedHost) {
        return false;
      }

      renderSession.terminal.fit?.();
      renderSession.terminal.focus();
      return true;
    },
    async requestNewTab(workspaceId) {
      const activeShellBridge = shellMount?.bridge ?? null;
      if (activeShellBridge) {
        const openedEvent = await activeShellBridge.open({
          type: "terminal/open",
          workspaceId,
          cols: DEFAULT_TERMINAL_OPEN_COLS,
          rows: DEFAULT_TERMINAL_OPEN_ROWS,
        });
        registerOpenedTerminal(openedEvent, true);
        return openedEvent.tabId;
      }

      const tabId = createRequestedTabId(workspaceId, get().tabs);
      const nextWorkspaceTabIndex =
        get().tabs.filter((tab) => tab.workspaceId === workspaceId).length + 1;
      get().createTab({
        id: tabId,
        workspaceId,
        title: `Terminal ${nextWorkspaceTabIndex}`,
        activate: true,
      });
      return tabId;
    },
    getMountedHost(sessionId) {
      return renderSessionsById.get(sessionId)?.mountedHost ?? null;
    },
    dispose() {
      shellMountCount = 0;
      stopShellBridge();
      dataListeners.clear();
      tabExitedListeners.clear();
      inputListeners.clear();
      tabClosedListeners.clear();
    },
    getLifecycleSnapshot() {
      return { shellMounted: shellMountCount > 0 };
    },
    createTerminal(input) {
      return get().createTab(input);
    },
    closeTerminal(tabId) {
      get().closeTab(tabId);
    },
    activateTerminal(tabId) {
      get().setActiveTab(tabId);
    },
      getActiveTerminal() {
        return get().getActiveTab();
      },
    };
  });

  function ensureRenderSession(sessionId: TerminalTabId): TerminalRenderSession {
    const existingRenderSession = renderSessionsById.get(sessionId);
    if (existingRenderSession) {
      return existingRenderSession;
    }

    const renderSession: TerminalRenderSession = {
      terminal: xtermDependencies.createTerminal({
        terminalOptions: createXtermOptions(),
        onInput: (data) => {
          getState().sendInput(sessionId, data);
        },
        onResize: (size) => {
          resizeShellSession(sessionId, size.cols, size.rows);
        },
      }),
      mountedHost: null,
      writtenDataEventCount: 0,
    };
    renderSessionsById.set(sessionId, renderSession);
    return renderSession;
  }

  function replayPendingDataEvents(
    renderSession: TerminalRenderSession,
    sessionId: TerminalTabId,
    dataEvents: readonly TerminalDataEvent[],
  ): void {
    const sessionDataEvents = dataEvents.filter((event) => event.tabId === sessionId);
    for (const dataEvent of sessionDataEvents.slice(renderSession.writtenDataEventCount)) {
      renderSession.terminal.write(dataEvent.data);
    }
    renderSession.writtenDataEventCount = sessionDataEvents.length;
  }

  function writeDataEventToRenderSession(dataEvent: TerminalDataEvent): void {
    const renderSession = renderSessionsById.get(dataEvent.tabId);
    if (!renderSession) {
      return;
    }

    renderSession.terminal.write(dataEvent.data);
    renderSession.writtenDataEventCount += 1;
  }

  function disposeRenderSession(sessionId: TerminalTabId): void {
    const renderSession = renderSessionsById.get(sessionId);
    if (!renderSession) {
      return;
    }

    renderSession.mountedHost = null;
    renderSession.terminal.dispose();
    renderSessionsById.delete(sessionId);
  }

  function startShellBridge(): void {
    if (shellMount) {
      return;
    }

    const bridge = shellDependencies.createBridge();
    if (!bridge) {
      return;
    }

    const subscriptions: Array<TerminalBridgeDisposable | TerminalServiceUnsubscribe> = [
      bridge.onOpened((event) => {
        registerOpenedTerminal(event, true);
      }),
      bridge.onStdout((event) => {
        getState().receiveData({
          tabId: event.tabId,
          seq: event.seq,
          data: event.data,
          mainBufferDroppedBytes: event.mainBufferDroppedBytes,
        });
      }),
      bridge.onExited((event) => {
        getState().markTabExited({
          tabId: event.tabId,
          workspaceId: event.workspaceId,
          reason: event.reason,
          exitCode: event.exitCode,
        });
      }),
      getState().onInput((event) => {
        void bridge.input({
          type: "terminal/input",
          tabId: event.tabId,
          data: event.data,
        }).catch((error) => {
          console.error("Terminal service: failed to send terminal input.", error);
        });
      }),
      getState().onTabClosed((event) => {
        void bridge.close({
          type: "terminal/close",
          tabId: event.tabId,
          reason: event.reason,
        }).catch((error) => {
          console.error("Terminal service: failed to close terminal tab.", error);
        });
      }),
    ];

    shellMount = { bridge, subscriptions };
  }

  function stopShellBridge(): void {
    const currentShellMount = shellMount;
    if (!currentShellMount) {
      return;
    }

    shellMount = null;
    for (const subscription of currentShellMount.subscriptions) {
      if (typeof subscription === "function") {
        subscription();
      } else {
        subscription.dispose();
      }
    }
    currentShellMount.bridge.dispose();
  }

  function registerOpenedTerminal(event: TerminalOpenedEvent, activate: boolean): void {
    const existingTab = getState().tabs.find((tab) => tab.id === event.tabId) ?? null;
    const nextWorkspaceTabIndex = existingTab
      ? null
      : getState().tabs.filter((tab) => tab.workspaceId === event.workspaceId).length + 1;
    getState().createTab({
      id: event.tabId,
      workspaceId: event.workspaceId,
      title: existingTab?.title ?? `Terminal ${nextWorkspaceTabIndex}`,
      shell: terminalOpenedEventString(event, "shell") ?? existingTab?.shell ?? null,
      cwd: terminalOpenedEventString(event, "cwd") ?? existingTab?.cwd ?? null,
      status: "running",
      pid: event.pid,
      activate,
    });
  }

  function resizeShellSession(sessionId: TerminalTabId, cols: number, rows: number): void {
    const bridge = shellMount?.bridge ?? null;
    if (!bridge) {
      return;
    }

    void bridge.resize({
      type: "terminal/resize",
      tabId: sessionId,
      cols: normalizePositiveInteger(cols, 1),
      rows: normalizePositiveInteger(rows, 1),
    }).catch((error) => {
      console.error("Terminal service: failed to resize terminal tab.", error);
    });
  }

  function createRequestedTabId(
    workspaceId: WorkspaceId,
    existingTabs: readonly TerminalTab[],
  ): TerminalTabId {
    const workspaceSlug = workspaceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
    let tabId: TerminalTabId;
    do {
      requestedTabSequence += 1;
      tabId = `${REQUESTED_TAB_ID_PREFIX}_${workspaceSlug}_${requestedTabSequence.toString(36)}`;
    } while (
      existingTabs.some((tab) => tab.id === tabId) ||
      renderSessionsById.has(tabId)
    );

    return tabId;
  }
}

function createXtermOptions(): ITerminalOptions {
  return {};
}

function normalizeInitialState(initialState: Partial<TerminalServiceState>): TerminalServiceState {
  const tabs = cloneTabs(initialState.tabs ?? DEFAULT_TERMINAL_STATE.tabs);
  const activeTabIdByWorkspaceId = {
    ...DEFAULT_TERMINAL_STATE.activeTabIdByWorkspaceId,
    ...initialState.activeTabIdByWorkspaceId,
  };

  for (const tab of tabs) {
    const workspaceKey = createWorkspaceKey(tab.workspaceId);
    if (!activeTabIdByWorkspaceId[workspaceKey]) {
      activeTabIdByWorkspaceId[workspaceKey] = tab.id;
    }
  }

  const activeWorkspaceId = initialState.activeWorkspaceId ??
    tabs.find((tab) => tab.id === initialState.activeTabId)?.workspaceId ??
    tabs[0]?.workspaceId ??
    DEFAULT_TERMINAL_STATE.activeWorkspaceId;
  const state = {
    ...DEFAULT_TERMINAL_STATE,
    ...initialState,
    tabs,
    activeWorkspaceId,
    activeTabIdByWorkspaceId,
    dataEvents: [...(initialState.dataEvents ?? DEFAULT_TERMINAL_STATE.dataEvents)],
    exitEvents: [...(initialState.exitEvents ?? DEFAULT_TERMINAL_STATE.exitEvents)],
    lastDataByTabId: {
      ...DEFAULT_TERMINAL_STATE.lastDataByTabId,
      ...initialState.lastDataByTabId,
    },
  };

  return {
    ...state,
    activeTabId: resolveInitialActiveTabId(state, initialState.activeTabId ?? null),
  };
}

function resolveInitialActiveTabId(
  state: TerminalServiceState,
  requestedActiveTabId: TerminalTabId | null,
): TerminalTabId | null {
  if (requestedActiveTabId && state.tabs.some((tab) => tab.id === requestedActiveTabId)) {
    return requestedActiveTabId;
  }

  return resolveActiveTabIdForWorkspace(state, state.activeWorkspaceId);
}

function resolveActiveTabIdForWorkspace(
  state: TerminalServiceState,
  workspaceId: WorkspaceId | null,
): TerminalTabId | null {
  const workspaceTabs = state.tabs.filter((tab) => tab.workspaceId === workspaceId);
  if (workspaceTabs.length === 0) {
    return null;
  }

  const workspaceActiveTabId = state.activeTabIdByWorkspaceId[createWorkspaceKey(workspaceId)];
  if (workspaceActiveTabId && workspaceTabs.some((tab) => tab.id === workspaceActiveTabId)) {
    return workspaceActiveTabId;
  }

  return workspaceTabs.at(-1)?.id ?? null;
}

function resolveNextTabIdAfterClose(
  tabsBeforeClose: TerminalTab[],
  closedTabId: TerminalTabId,
  workspaceId: WorkspaceId | null,
): TerminalTabId | null {
  const workspaceTabs = tabsBeforeClose.filter((tab) => tab.workspaceId === workspaceId);
  const closedIndex = workspaceTabs.findIndex((tab) => tab.id === closedTabId);
  if (closedIndex === -1) {
    return null;
  }

  const nextWorkspaceTabs = workspaceTabs.filter((tab) => tab.id !== closedTabId);
  return nextWorkspaceTabs[closedIndex]?.id ?? nextWorkspaceTabs.at(-1)?.id ?? null;
}

function createDataEvent(tab: TerminalTab, input: TerminalDataInput): TerminalDataEvent {
  const event: TerminalDataEvent = {
    tabId: input.tabId,
    workspaceId: tab.workspaceId,
    seq: input.seq ?? null,
    data: input.data,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
  };

  if (input.mainBufferDroppedBytes !== undefined) {
    event.mainBufferDroppedBytes = input.mainBufferDroppedBytes;
  }

  return event;
}

function terminalOpenedEventString(event: TerminalOpenedEvent, key: "shell" | "cwd"): string | null {
  const value = (event as TerminalOpenedEvent & Partial<Record<"shell" | "cwd", unknown>>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function createWorkspaceKey(workspaceId: WorkspaceId | null): string {
  return workspaceId ?? NULL_WORKSPACE_KEY;
}

function cloneSnapshot(state: TerminalServiceSnapshot): TerminalServiceSnapshot {
  return {
    tabs: cloneTabs(state.tabs),
    activeTabId: state.activeTabId,
    activeWorkspaceId: state.activeWorkspaceId,
    activeTabIdByWorkspaceId: { ...state.activeTabIdByWorkspaceId },
    dataEvents: state.dataEvents.map((event) => ({ ...event })),
    exitEvents: state.exitEvents.map((event) => ({ ...event })),
    lastDataByTabId: { ...state.lastDataByTabId },
  };
}

function cloneNullableTab(tab: TerminalTab | null): TerminalTab | null {
  return tab ? cloneTab(tab) : null;
}

function cloneTabs(tabs: readonly TerminalTab[]): TerminalTab[] {
  return tabs.map(cloneTab);
}

function cloneTab(tab: TerminalTab): TerminalTab {
  return { ...tab };
}

function emitToListeners<TEvent>(listeners: ReadonlySet<(event: TEvent) => void>, event: TEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  TerminalCloseReason,
  TerminalExitedReason,
} from "../../../../shared/src/contracts/terminal/terminal-ipc";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export type TerminalTabId = string;
export type TerminalTabStatus = "idle" | "connecting" | "running" | "exited";

export interface TerminalTab {
  id: TerminalTabId;
  title: string;
  workspaceId: WorkspaceId | null;
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
 * Stores PTY tab metadata and lifecycle events only.
 * Bottom panel view selection, placement, expansion, and height persistence stay in IBottomPanelService.
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

const DEFAULT_TERMINAL_STATE: TerminalServiceState = {
  tabs: [],
  activeTabId: null,
  activeWorkspaceId: null,
  activeTabIdByWorkspaceId: {},
  dataEvents: [],
  exitEvents: [],
  lastDataByTabId: {},
};

export function createTerminalService(
  initialState: Partial<TerminalServiceState> = {},
): TerminalServiceStore {
  const initial = normalizeInitialState(initialState);
  const dataListeners = new Set<TerminalDataListener>();
  const tabExitedListeners = new Set<TerminalTabExitedListener>();
  const inputListeners = new Set<TerminalInputListener>();
  const tabClosedListeners = new Set<TerminalTabClosedListener>();
  let shellMountCount = 0;

  return createStore<ITerminalService>((set, get) => ({
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
    },
    dispose() {
      shellMountCount = 0;
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
  }));
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

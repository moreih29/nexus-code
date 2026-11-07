/**
 * The agent manager in the renderer (shared/manager): its settings, mirrored
 * from AppState and saved back through appState.set; whether its dock is
 * open and what came while it was shut; and the sessions it handed work to,
 * its tasks, kept in this window's storage across restarts.
 */

import { create } from "zustand";
import { DEFAULT_MANAGER_SETTINGS, type ManagerSettings } from "../../../shared/manager/manager";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { AppState } from "../../../shared/types/app-state";
import { ipcCallResult } from "../../ipc/client";

/** A session the manager handed work to. */
export interface ManagerTask {
  readonly workspaceId: string;
  readonly tabId: string;
  /** When it first did. */
  readonly since: number;
  /** What it sent the session, the latest last: those messages are marked as its. */
  readonly sent: readonly string[];
}

/** The manager's conversation as it runs now; a new one each time it starts. */
export interface ManagerLive {
  readonly agent: ChatAgent;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly cwd: string;
  /** Counts its starts: a view of an earlier one is made again. */
  readonly run: number;
}

/** The session or thread the manager goes on with. */
export interface ManagerSession {
  readonly agent: ChatAgent;
  readonly id: string;
}

const TASKS_KEY = "nexus.manager.tasks";
const DOCK_KEY = "nexus.manager.dock";
/** Tasks kept, the latest; and messages kept of each. */
const MAX_TASKS = 50;
const MAX_SENT = 20;

type ManagerAppState = Pick<
  AppState,
  | "managerEnabled"
  | "managerAgent"
  | "managerNotify"
  | "managerPermissions"
  | "managerReports"
  | "managerSession"
>;

interface ManagerState extends ManagerSettings {
  session: ManagerSession | undefined;
  live: ManagerLive | undefined;
  dockOpen: boolean;
  /** The manager's reports that came while its dock was shut. */
  unread: number;
  /** By session key (`${workspaceId}:${tabId}`). */
  tasks: Readonly<Record<string, ManagerTask>>;
  hydrate(state: Partial<ManagerAppState>): void;
  /** Changes settings here and saves them. */
  setSettings(patch: Partial<ManagerSettings>): void;
  setSession(session: ManagerSession | undefined): void;
  setLive(live: ManagerLive | undefined): void;
  setDockOpen(open: boolean): void;
  addUnread(): void;
  /** The manager handed work to a session, sending it `text` when it did. */
  dispatched(workspaceId: string, tabId: string, text: string | undefined, at: number): void;
  dropTask(key: string): void;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not kept: gone after a restart.
  }
}

function save(patch: Partial<ManagerAppState>): void {
  void ipcCallResult("appState", "set", patch);
}

export const useManagerStore = create<ManagerState>((set, get) => ({
  ...DEFAULT_MANAGER_SETTINGS,
  session: undefined,
  live: undefined,
  dockOpen: readJson<unknown>(DOCK_KEY, false) === true,
  unread: 0,
  tasks: readJson<Record<string, ManagerTask>>(TASKS_KEY, {}),

  hydrate(state) {
    set({
      enabled: state.managerEnabled ?? DEFAULT_MANAGER_SETTINGS.enabled,
      agent: state.managerAgent ?? DEFAULT_MANAGER_SETTINGS.agent,
      notify: state.managerNotify ?? DEFAULT_MANAGER_SETTINGS.notify,
      permissions: state.managerPermissions ?? DEFAULT_MANAGER_SETTINGS.permissions,
      reports: state.managerReports ?? DEFAULT_MANAGER_SETTINGS.reports,
      session: state.managerSession?.id ? state.managerSession : undefined,
    });
  },

  setSettings(patch) {
    set(patch);
    save({
      ...(patch.enabled !== undefined ? { managerEnabled: patch.enabled } : {}),
      ...(patch.agent !== undefined ? { managerAgent: patch.agent } : {}),
      ...(patch.notify !== undefined ? { managerNotify: patch.notify } : {}),
      ...(patch.permissions !== undefined ? { managerPermissions: patch.permissions } : {}),
      ...(patch.reports !== undefined ? { managerReports: patch.reports } : {}),
    });
  },

  setSession(session) {
    const now = get().session;
    if (now?.agent === session?.agent && now?.id === session?.id) return;
    set({ session });
    // appState.set merges what it is given: an empty id drops the session.
    save({ managerSession: session ?? { agent: get().agent, id: "" } });
  },

  setLive(live) {
    set({ live });
  },

  setDockOpen(dockOpen) {
    set(dockOpen ? { dockOpen, unread: 0 } : { dockOpen });
    writeJson(DOCK_KEY, dockOpen);
  },

  addUnread() {
    set((s) => ({ unread: s.unread + 1 }));
  },

  dispatched(workspaceId, tabId, text, at) {
    const key = `${workspaceId}:${tabId}`;
    const was = get().tasks[key];
    const sent = text ? [...(was?.sent ?? []), text].slice(-MAX_SENT) : (was?.sent ?? []);
    const task: ManagerTask = { workspaceId, tabId, since: was?.since ?? at, sent };
    const kept = Object.entries({ ...get().tasks, [key]: task })
      .sort(([, a], [, b]) => a.since - b.since)
      .slice(-MAX_TASKS);
    const tasks = Object.fromEntries(kept);
    set({ tasks });
    writeJson(TASKS_KEY, tasks);
  },

  dropTask(key) {
    const { [key]: _dropped, ...tasks } = get().tasks;
    set({ tasks });
    writeJson(TASKS_KEY, tasks);
  },
}));

/** Whether the manager sent `text` to the session, by `tasks`: the message is marked as its. */
export function sentIn(
  tasks: ManagerState["tasks"],
  workspaceId: string,
  tabId: string,
  text: string,
): boolean {
  const said = text.trim();
  return tasks[`${workspaceId}:${tabId}`]?.sent.some((sent) => sent.trim() === said) ?? false;
}

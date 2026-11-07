/**
 * The agent manager: one Claude Code or Codex session the app runs beside
 * the user's, which follows every workspace's agent sessions through the
 * nexus command and directs them. It lives in a workspace of its own that
 * the app keeps out of its lists, in one tab, both with fixed ids.
 */

import type { ChatAgent } from "../sessions/task-agent";

/** The manager's own workspace: a folder of the app's, never listed. */
export const MANAGER_WORKSPACE_ID = "a9e0a9e0-0000-4000-8000-000000000001";
/** The manager's tab in it. */
export const MANAGER_TAB_ID = "a9e0a9e0-0000-4000-8000-000000000002";

export function isManagerWorkspace(workspaceId: string): boolean {
  return workspaceId === MANAGER_WORKSPACE_ID;
}

/** Whether the nexus caller is the manager. */
export function isManager(caller: {
  readonly workspaceId: string;
  readonly tabId: string;
}): boolean {
  return caller.workspaceId === MANAGER_WORKSPACE_ID && caller.tabId === MANAGER_TAB_ID;
}

/**
 * Which session changes the app tells the manager: those of the work it
 * handed out; those and any session waiting on the user or stopped on an
 * error; or every change but one going to work.
 */
export const MANAGER_NOTIFY = ["tasks", "attention", "all"] as const;
export type ManagerNotify = (typeof MANAGER_NOTIFY)[number];

/**
 * What the manager may do with another session's permission request:
 * leave it to the user, answer it once the user agrees each time, or
 * answer it.
 */
export const MANAGER_PERMISSIONS = ["user", "ask", "answer"] as const;
export type ManagerPermissions = (typeof MANAGER_PERMISSIONS)[number];

export interface ManagerSettings {
  readonly enabled: boolean;
  readonly agent: ChatAgent;
  readonly notify: ManagerNotify;
  readonly permissions: ManagerPermissions;
  /** Its reports as desktop notifications too, when the user is not looking. */
  readonly reports: boolean;
}

export const DEFAULT_MANAGER_SETTINGS: ManagerSettings = {
  enabled: false,
  agent: "claude",
  notify: "attention",
  permissions: "user",
  reports: true,
};

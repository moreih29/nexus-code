/**
 * The agent manager: one Claude Code or Codex session the app runs beside
 * the user's, which follows every workspace's agent sessions through the
 * nexus command and directs them. It lives in a workspace of its own that
 * the app keeps out of its lists, in one tab, both with fixed ids.
 */

import {
  type AgentProfile,
  type AgentProfiles,
  hasProfile,
  profileOf,
} from "../agent-profiles/profiles";
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
  /** The profile each agent runs the manager with; none = the agent's default profile. */
  readonly profiles: Readonly<Partial<Record<ChatAgent, string>>>;
  readonly notify: ManagerNotify;
  readonly permissions: ManagerPermissions;
  /** Its reports as desktop notifications too, when the user is not looking. */
  readonly reports: boolean;
}

export const DEFAULT_MANAGER_SETTINGS: ManagerSettings = {
  enabled: false,
  agent: "claude",
  profiles: {},
  notify: "attention",
  permissions: "user",
  reports: true,
};

/**
 * The profile the manager runs with as `agent`: the one chosen for it, or
 * else (none chosen, or the one chosen since removed) the agent's default
 * profile, as Settings › Profiles by workspace sets it.
 */
export function managerProfileOf(
  config: AgentProfiles,
  agent: ChatAgent,
  chosen: string | undefined,
): AgentProfile {
  const id = chosen && hasProfile(config, agent, chosen) ? chosen : config.defaults[agent];
  return profileOf(config, agent, id);
}

/**
 * Whether the manager, running as `agent` with the profile `profileId`, may
 * go on with `session`: a session lives in its agent's profile's folder,
 * and another folder has not got it. One saved before sessions kept their
 * profile is taken as the one it runs with, which was the default then.
 */
export function sessionFits(
  session: { readonly agent: ChatAgent; readonly profileId?: string },
  agent: ChatAgent,
  profileId: string,
): boolean {
  if (session.agent !== agent) return false;
  return session.profileId === undefined || session.profileId === profileId;
}

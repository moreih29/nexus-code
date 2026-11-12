/**
 * The agent sessions of a workspace and its tasks, as the agent list shows
 * them. Pure: built from the stores' records, so every view reads the same
 * worktrees, sessions and states.
 */

import type { StatusEntry } from "../../../shared/claude/status";
import {
  describeTerminal,
  isAgentSession,
  type TabActivity,
  type TabActivityEntry,
} from "../../../shared/sessions/agent-state";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { Tab } from "../../state/stores/tabs";
import type { ChatTabState } from "../chat/store";
import { codexStateOf } from "./codex-state";

/**
 * Where a session stands for the user: waiting on them (a permission, an
 * answer, an error), working, done and not yet looked at, or idle.
 */
export type SessionPhase = "attention" | "running" | "done" | "idle";

export interface AgentSession {
  /** `${workspaceId}:${tabId}`. */
  readonly key: string;
  readonly workspaceId: string;
  readonly tabId: string;
  /** The tab's title. */
  readonly title: string;
  /**
   * The kind of tab: a terminal, or a Claude or Codex tab, whose program
   * takes messages rather than keys.
   */
  readonly kind: "terminal" | "claude" | "codex";
  /** "claude", "codex", or undefined for an agent known only by its notifications. */
  readonly agent: string | undefined;
  /**
   * Claude's status (idle, running, completed, needsInput, permissionPending,
   * error), a Codex tab's in the same words; for other agents busy or quiet;
   * "exited" once the terminal ended.
   */
  readonly state: string;
  readonly phase: SessionPhase;
  /** True when the state is read from output, not reported by hooks. */
  readonly estimated: boolean;
  /** When the state began. */
  readonly since: number | undefined;
  /** Claude's last answer or question, or the agent's last notification. */
  readonly message: string | undefined;
  /** The last prompt the user gave Claude. */
  readonly prompt: string | undefined;
}

export interface WorktreeEntry {
  readonly workspace: WorkspaceMeta;
  /** The workspace itself, not one of its tasks. */
  readonly isRoot: boolean;
  /** A task's branch; the workspace's own is read from git. */
  readonly branch: string | undefined;
  readonly sessions: readonly AgentSession[];
}

export interface SessionFamily {
  readonly root: WorkspaceMeta;
  readonly worktrees: readonly WorktreeEntry[];
}

/** The records the sessions of a workspace are read from. */
export interface SessionsInput {
  readonly tabsByWorkspace: Readonly<Record<string, Readonly<Record<string, Tab>>>>;
  readonly claudeByWorkspace: Readonly<Record<string, Readonly<Record<string, StatusEntry>>>>;
  /** Keyed by `${workspaceId}:${tabId}`. */
  readonly activity: ReadonlyMap<string, TabActivity>;
  readonly now: number;
  /**
   * workspaceId → tabId → when the user last looked at the terminal. A turn
   * Codex or another agent finished before then reads as looked at, as
   * Claude's own completed state does once its tab is seen.
   */
  readonly seenByWorkspace?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The chat tabs' conversations, by session key: a Codex tab's state is read from its own. */
  readonly chats?: Readonly<Record<string, ChatTabState>>;
  /** The tab in front of the user, by session key; a Codex turn it ends is looked at. */
  readonly viewing?: string | null;
}

export interface FamilyInput extends SessionsInput {
  readonly workspaces: readonly WorkspaceMeta[];
  /** The workspace the tab is in: the root, or one of its tasks. */
  readonly workspaceId: string;
}

export function phaseOf(state: string): SessionPhase {
  switch (state) {
    case "permissionPending":
    case "needsInput":
    case "error":
      return "attention";
    case "running":
    case "busy":
      return "running";
    case "completed":
      return "done";
    default:
      return "idle";
  }
}

export function sessionKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}

/** The terminals' activity as main reports it, by session key. */
export function activityByKey(entries: readonly TabActivityEntry[]): Map<string, TabActivity> {
  return new Map(entries.map((entry) => [sessionKey(entry.workspaceId, entry.tabId), entry]));
}

/** Whether two reads of the terminals' activity tell the same. */
export function sameActivity(
  a: ReadonlyMap<string, TabActivity>,
  b: ReadonlyMap<string, TabActivity>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, x] of a) {
    const y = b.get(key);
    if (
      y === undefined ||
      x.lastOutputAt !== y.lastOutputAt ||
      x.program !== y.program ||
      x.lastNotice?.at !== y.lastNotice?.at ||
      x.lastNotice?.body !== y.lastNotice?.body ||
      x.lastNotice?.title !== y.lastNotice?.title
    ) {
      return false;
    }
  }
  return true;
}

/** Whether the user looked at the terminal after `terminal`'s state began. */
function seenSince(seenAt: number | undefined, terminal: { readonly since?: number }): boolean {
  return seenAt !== undefined && seenAt >= (terminal.since ?? 0);
}

/**
 * What the tab bar and the sidebar show for a terminal whose agent's state
 * is told from its output, beside Claude's own: running while it prints,
 * completed for a turn the user has not looked at, else nothing. A turn that
 * ends while the user has the terminal in front of them (`viewing`) counts
 * as looked at, as main does for Claude.
 */
export type EstimatedGlyph = "running" | "completed";

export function estimatedGlyph(
  tab: Tab,
  activity: TabActivity | undefined,
  seenAt: number | undefined,
  now: number,
  viewing: boolean,
): EstimatedGlyph | null {
  if (tab.type !== "terminal" || tab.props.dead) return null;
  const terminal = describeTerminal(null, activity ?? null, tab.title, now);
  if (!isAgentSession(terminal)) return null;
  if (terminal.state === "busy") return "running";
  if (terminal.state === "completed" && !viewing && !seenSince(seenAt, terminal)) {
    return "completed";
  }
  return null;
}

/** The stronger of two glyphs: a finished turn to look at over work going on. */
export function strongerGlyph(
  a: EstimatedGlyph | null,
  b: EstimatedGlyph | null,
): EstimatedGlyph | null {
  return a === "completed" || b === "completed" ? "completed" : (a ?? b);
}

/**
 * The estimated glyph of the terminals of `workspaceIds` that Claude has no
 * state for, the strongest of them.
 */
export function workspaceEstimatedGlyph(
  input: SessionsInput,
  workspaceIds: readonly string[],
  viewing: string | null,
): EstimatedGlyph | null {
  let glyph: EstimatedGlyph | null = null;
  for (const workspaceId of workspaceIds) {
    const claude = input.claudeByWorkspace[workspaceId] ?? {};
    const seen = input.seenByWorkspace?.[workspaceId] ?? {};
    for (const tab of Object.values(input.tabsByWorkspace[workspaceId] ?? {})) {
      if (claude[tab.id] !== undefined) continue;
      const key = sessionKey(workspaceId, tab.id);
      glyph = strongerGlyph(
        glyph,
        estimatedGlyph(tab, input.activity.get(key), seen[tab.id], input.now, key === viewing),
      );
      if (glyph === "completed") return glyph;
    }
  }
  return glyph;
}

/** The agent sessions in the terminals, Claude tabs and Codex tabs of `workspace`. */
export function sessionsOf(input: SessionsInput, workspace: WorkspaceMeta): AgentSession[] {
  const tabs = input.tabsByWorkspace[workspace.id] ?? {};
  const claude = input.claudeByWorkspace[workspace.id] ?? {};
  const seen = input.seenByWorkspace?.[workspace.id] ?? {};
  const sessions: AgentSession[] = [];
  for (const tab of Object.values(tabs)) {
    const key = sessionKey(workspace.id, tab.id);
    const status = claude[tab.id];
    if (tab.type === "claude") {
      // Its hooks tell its state once its program started; idle until then.
      const state = status?.status ?? "idle";
      sessions.push({
        key,
        workspaceId: workspace.id,
        tabId: tab.id,
        title: tab.title,
        kind: "claude",
        agent: "claude",
        state,
        phase: phaseOf(state),
        estimated: false,
        since: status?.since,
        message: status?.message,
        prompt: status?.prompt,
      });
      continue;
    }
    if (tab.type === "codex") {
      const codex = codexStateOf(input.chats?.[key], seen[tab.id], key === input.viewing);
      sessions.push({
        key,
        workspaceId: workspace.id,
        tabId: tab.id,
        title: tab.title,
        kind: "codex",
        agent: "codex",
        state: codex.state,
        phase: phaseOf(codex.state),
        estimated: false,
        since: codex.since,
        message: codex.message,
        prompt: codex.prompt,
      });
      continue;
    }
    if (tab.type !== "terminal") continue;
    const terminal = describeTerminal(
      status ?? null,
      input.activity.get(key) ?? null,
      tab.title,
      input.now,
    );
    if (!isAgentSession(terminal)) continue;
    const state = tab.props.dead
      ? "exited"
      : status === undefined && terminal.state === "completed" && seenSince(seen[tab.id], terminal)
        ? "quiet"
        : terminal.state;
    sessions.push({
      key,
      workspaceId: workspace.id,
      tabId: tab.id,
      title: tab.title,
      kind: "terminal",
      agent: terminal.agent,
      state,
      phase: phaseOf(state),
      estimated: status === undefined,
      since: terminal.since,
      message: terminal.message,
      prompt: status?.prompt,
    });
  }
  return sessions;
}

/** The workspace `workspaceId` belongs to with its tasks, and their sessions. */
export function buildFamily(input: FamilyInput): SessionFamily | null {
  const own = input.workspaces.find((w) => w.id === input.workspaceId);
  if (!own) return null;
  const rootId = own.task?.parentId ?? own.id;
  const root = input.workspaces.find((w) => w.id === rootId);
  if (!root) return null;
  const tasks = input.workspaces.filter((w) => w.task?.parentId === root.id);
  const worktrees = [root, ...tasks].map((workspace) => ({
    workspace,
    isRoot: workspace.id === root.id,
    branch: workspace.task?.branch,
    sessions: sessionsOf(input, workspace),
  }));
  return { root, worktrees };
}

const SESSION_FIELDS = [
  "key",
  "title",
  "kind",
  "agent",
  "state",
  "phase",
  "estimated",
  "since",
  "message",
  "prompt",
] as const satisfies readonly (keyof AgentSession)[];

/** Whether two builds of a family show the same. */
export function sameFamily(a: SessionFamily | null, b: SessionFamily | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.root !== b.root || a.worktrees.length !== b.worktrees.length) return false;
  return a.worktrees.every((x, i) => {
    const y = b.worktrees[i];
    return (
      x.workspace === y.workspace &&
      x.isRoot === y.isRoot &&
      x.branch === y.branch &&
      x.sessions.length === y.sessions.length &&
      x.sessions.every((s, j) => SESSION_FIELDS.every((field) => s[field] === y.sessions[j][field]))
    );
  });
}

export function allSessions(family: SessionFamily): AgentSession[] {
  return family.worktrees.flatMap((w) => w.sessions);
}

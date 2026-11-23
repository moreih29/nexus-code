import type { TerminalOpener } from "../../../shared/chat/relay";
import type { StatusEntry } from "../../../shared/claude/status";
import {
  describeTerminal,
  isAgentSession,
  type TabActivity,
  type TabActivityEntry,
} from "../../../shared/sessions/agent-state";
import type { LimitResume } from "../../../shared/types/layout";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { shortId } from "../../../shared/util/short-id";
import type { Tab } from "../../state/stores/tabs";
import type { ChatTabState } from "../chat/store";
import { remoteDisplayName, remoteTitle } from "../remote/display-name";
import { claudeChatStateOf, codexStateOf } from "./codex-state";

export type SessionPhase = "attention" | "running" | "done" | "idle";

export interface AgentSession {
  readonly key: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly title: string;
  readonly parent?: TerminalOpener;
  readonly openedAt?: number;
  readonly kind: "terminal" | "claude" | "codex";
  readonly agent: string | undefined;
  readonly state: string;
  readonly phase: SessionPhase;
  readonly estimated: boolean;
  readonly since: number | undefined;
  readonly message: string | undefined;
  readonly prompt: string | undefined;
  readonly hasTurns?: boolean;
  readonly limitWait?: { readonly at: number };
}

export function sessionParentName(opener: TerminalOpener | undefined, title?: string) {
  return (
    title ||
    (opener?.device ? remoteTitle(opener.name) : opener?.name) ||
    (opener?.device && remoteDisplayName(opener.tabId && shortId(opener.tabId))) ||
    (opener?.kind !== "tab" ? opener?.agent : undefined)
  );
}

function limitWaitOf(record: LimitResume | undefined): Pick<AgentSession, "limitWait"> {
  return record?.state === "waiting" && record.at !== undefined
    ? { limitWait: { at: record.at } }
    : {};
}

export interface WorktreeEntry {
  readonly workspace: WorkspaceMeta;
  readonly isRoot: boolean;
  readonly branch: string | undefined;
  readonly sessions: readonly AgentSession[];
}

export interface SessionFamily {
  readonly root: WorkspaceMeta;
  readonly worktrees: readonly WorktreeEntry[];
}

export interface SessionsInput {
  readonly tabsByWorkspace: Readonly<Record<string, Readonly<Record<string, Tab>>>>;
  readonly claudeByWorkspace: Readonly<Record<string, Readonly<Record<string, StatusEntry>>>>;
  readonly activity: ReadonlyMap<string, TabActivity>;
  readonly now: number;
  readonly seenByWorkspace?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly chats?: Readonly<Record<string, ChatTabState>>;
  readonly viewing?: string | null;
}

export interface FamilyInput extends SessionsInput {
  readonly workspaces: readonly WorkspaceMeta[];
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

export function activityByKey(entries: readonly TabActivityEntry[]): Map<string, TabActivity> {
  return new Map(entries.map((entry) => [sessionKey(entry.workspaceId, entry.tabId), entry]));
}

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

function seenSince(seenAt: number | undefined, terminal: { readonly since?: number }): boolean {
  return seenAt !== undefined && seenAt >= (terminal.since ?? 0);
}

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

export function strongerGlyph(
  a: EstimatedGlyph | null,
  b: EstimatedGlyph | null,
): EstimatedGlyph | null {
  return a === "completed" || b === "completed" ? "completed" : (a ?? b);
}

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

export function sessionsOf(input: SessionsInput, workspace: WorkspaceMeta): AgentSession[] {
  const tabs = input.tabsByWorkspace[workspace.id] ?? {};
  const claude = input.claudeByWorkspace[workspace.id] ?? {};
  const seen = input.seenByWorkspace?.[workspace.id] ?? {};
  const sessions: AgentSession[] = [];
  for (const tab of Object.values(tabs)) {
    const key = sessionKey(workspace.id, tab.id);
    const status = claude[tab.id];
    const chat = input.chats?.[key];
    const opener =
      (tab.type === "claude" || tab.type === "codex" || tab.type === "terminal") &&
      tab.props.openedBy
        ? { parent: tab.props.openedBy, openedAt: tab.openedAt }
        : {};
    const hasTurns = Boolean(
      chat?.model.lastResult ||
        chat?.model.items.some((item) => item.kind === "user") ||
        chat?.history?.items.some((item) => item.kind === "user" || item.kind === "assistant"),
    );
    if (tab.type === "claude") {
      const streamed = claudeChatStateOf(chat, seen[tab.id], key === input.viewing);
      const state = streamed?.state ?? status?.status ?? "idle";
      sessions.push({
        key,
        workspaceId: workspace.id,
        tabId: tab.id,
        title: tab.title,
        ...opener,
        kind: "claude",
        agent: "claude",
        state,
        phase: phaseOf(state),
        estimated: false,
        since: streamed ? streamed.since : status?.since,
        message: streamed ? streamed.message : status?.message,
        prompt: streamed?.prompt ?? status?.prompt,
        hasTurns,
        ...limitWaitOf(tab.props.limitResume),
      });
      continue;
    }
    if (tab.type === "codex") {
      const codex = codexStateOf(chat, seen[tab.id], key === input.viewing);
      sessions.push({
        key,
        workspaceId: workspace.id,
        tabId: tab.id,
        title: tab.title,
        ...opener,
        kind: "codex",
        agent: "codex",
        state: codex.state,
        phase: phaseOf(codex.state),
        estimated: false,
        since: codex.since,
        message: codex.message,
        prompt: codex.prompt,
        hasTurns,
        ...limitWaitOf(tab.props.limitResume),
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
      ...opener,
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
  "parent",
  "openedAt",
  "kind",
  "agent",
  "state",
  "phase",
  "estimated",
  "since",
  "message",
  "prompt",
  "hasTurns",
] as const satisfies readonly (keyof AgentSession)[];

export function sameSession(a: AgentSession, b: AgentSession): boolean {
  return (
    a.limitWait?.at === b.limitWait?.at && SESSION_FIELDS.every((field) => a[field] === b[field])
  );
}

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
      x.sessions.every((s, j) => sameSession(s, y.sessions[j]))
    );
  });
}

export function allSessions(family: SessionFamily): AgentSession[] {
  return family.worktrees.flatMap((w) => w.sessions);
}

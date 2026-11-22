import {
  MAX_AGENT_DESCRIPTION,
  MAX_SESSION_AGENTS,
  type RemoteSession,
  type RemoteSessionAgent,
  type RemoteWorkspace,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
  type SessionState,
} from "../../../../../packages/remote-protocol/src";
import type { AgentRun } from "../../../../shared/claude/activity";
import type { CliChatState, CliSessionTab, CliUiOps } from "../../../../shared/cli/ui";
import { describeTerminal, isAgentSession } from "../../../../shared/sessions/agent-state";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { compareWorkspaceOrder } from "../../../../shared/workspace-order";
import type { CliServices, SessionsRevision } from "../../cli/context";
import { type ConsentControls, remoteConsents } from "../consents";
import type { RemoteNotes } from "../notes";
import { RpcFailure } from "../room";
import { oneLine, unavailable, workspaceOf } from "./common";
import { ReadBudget } from "./read-budget";

/** A chat's state as the agent lists show it. */
const CHAT_STATES: Record<CliChatState, SessionState> = {
  working: "running",
  asking: "needs-you",
  idle: "idle",
  error: "idle",
};

/**
 * A terminal agent's state: Claude Code's from its hooks (idle, running,
 * completed, needsInput, permissionPending, error), or another agent's
 * from the terminal's activity (busy, completed, quiet).
 */
function terminalSessionState(state: string): SessionState {
  if (state === "needsInput" || state === "permissionPending") return "needs-you";
  if (state === "running" || state === "busy") return "running";
  if (state === "completed") return "new-result";
  return "idle";
}

/**
 * The workspaces as the sidebar lists them: roots, pinned first and each
 * group in its own order, each followed by its task worktrees.
 */
function ordered(workspaces: readonly WorkspaceMeta[]): WorkspaceMeta[] {
  const roots = workspaces.filter((w) => !w.task).sort(compareWorkspaceOrder);
  const out: WorkspaceMeta[] = [];
  for (const root of roots)
    out.push(root, ...workspaces.filter((w) => w.task?.parentId === root.id));
  for (const w of workspaces) if (!out.includes(w)) out.push(w);
  return out;
}

/**
 * The agents a session runs that still run, as the agent list shows them
 * under its row: what each was asked to do on a line (a run told nothing
 * more, its prompt's start); none when there are none.
 */
export function sessionAgents(agents: readonly AgentRun[]): RemoteSessionAgent[] | undefined {
  const live = agents.filter((agent) => agent.end === undefined).slice(0, MAX_SESSION_AGENTS);
  if (live.length === 0) return undefined;
  return live.map((agent) => {
    const said = agent.description ?? (agent.kind === "print" ? agent.prompt : undefined);
    const description = said ? oneLine(said, MAX_AGENT_DESCRIPTION) : "";
    return {
      id: agent.id,
      kind: agent.kind,
      ...(agent.program ? { program: agent.program } : {}),
      ...(agent.type ? { type: oneLine(agent.type, 60) } : {}),
      ...(description ? { description } : {}),
      state: agent.state,
      start: agent.start,
    };
  });
}

function agentsField(
  services: CliServices,
  workspaceId: string,
  tabId: string,
): { agents?: RemoteSessionAgent[] } {
  const agents = sessionAgents(services.claudeAgents.list(workspaceId, tabId));
  return agents ? { agents } : {};
}

const UNREAD_RESULTS_MAX_AGE_MS = 30_000;

type UnreadResults = CliUiOps["sessions.results"]["result"]["unread"];
const lastUnreadResults = new WeakMap<CliServices, { startedAt: number; unread: UnreadResults }>();

/**
 * The unread map a read started at `startedAt` gave, kept for the reads
 * after it; when it gave none, the last one kept, for a while.
 */
function unreadResults(
  services: CliServices,
  startedAt: number,
  unread: UnreadResults | undefined,
): UnreadResults | undefined {
  const last = lastUnreadResults.get(services);
  if (unread && (!last || startedAt >= last.startedAt)) {
    lastUnreadResults.set(services, { startedAt, unread });
    return unread;
  }
  if (last && performance.now() - last.startedAt < UNREAD_RESULTS_MAX_AGE_MS) return last.unread;
  lastUnreadResults.delete(services);
}

/**
 * How long a read of the renderer stands for it at most: a change it did
 * not tell main of is in the list within this.
 */
export const SESSIONS_REREAD_MS = 10_000;

interface RendererRead {
  readonly tabs: readonly (readonly CliSessionTab[] | undefined)[];
  readonly unread: UnreadResults | undefined;
}

type SessionsSnapshot = CliUiOps["sessions.snapshot"]["result"];

/** The last whole read of the renderer, by its revision source. */
const lastReads = new WeakMap<
  SessionsRevision,
  { key: string; revision: number; readAt: number; read: RendererRead }
>();

/** Whether a read told every workspace's tabs, every chat's state and the unread map. */
function wholeRead(snapshot: SessionsSnapshot, workspaces: number): boolean {
  return (
    snapshot.unread !== undefined &&
    snapshot.workspaces.length === workspaces &&
    snapshot.workspaces.every(
      ({ tabs }) =>
        tabs?.every((tab) => (tab.type !== "claude" && tab.type !== "codex") || tab.chat) ?? false,
    )
  );
}

/**
 * What the renderer tells of the workspaces, in one request within the
 * budget: each one's tabs (none for one that could not be read) and the
 * unread map. The last whole read stands while the renderer tells no
 * change and for SESSIONS_REREAD_MS at most.
 */
async function readRenderer(
  services: CliServices,
  budget: ReadBudget,
  workspaceIds: string[],
): Promise<RendererRead> {
  const revisions = services.sessionsRevision;
  const key = workspaceIds.join("\n");
  const last = revisions && lastReads.get(revisions);
  if (
    last &&
    last.key === key &&
    last.revision === revisions.latest() &&
    performance.now() - last.readAt < SESSIONS_REREAD_MS
  ) {
    return last.read;
  }
  const startedAt = performance.now();
  const snapshot = await budget
    .ui("sessions.snapshot", { workspaceIds }, budget.remaining())
    .catch(() => undefined);
  const read: RendererRead = {
    tabs: workspaceIds.map((_, index) => snapshot?.workspaces[index]?.tabs),
    unread: unreadResults(services, startedAt, snapshot?.unread),
  };
  if (revisions && snapshot && Number.isSafeInteger(snapshot.revision)) {
    revisions.saw(snapshot.revision);
    // Only a whole one: what is missing is asked again at the next read.
    if (wholeRead(snapshot, workspaceIds.length)) {
      lastReads.set(revisions, { key, revision: snapshot.revision, readAt: startedAt, read });
    }
  }
  return read;
}

function chatSession(
  services: CliServices,
  workspaceId: string,
  tab: CliSessionTab,
): { row: RemoteSession; waitingId?: string } | undefined {
  if (tab.type !== "claude" && tab.type !== "codex") return undefined;
  const info = tab.chat;
  // The protocol has no unknown chat state. Leave the row out until it can be read.
  if (!info) return undefined;
  const row: RemoteSession = {
    workspaceId,
    tabId: tab.id,
    kind: tab.type,
    title: tab.title,
    state: CHAT_STATES[info.state],
    ...(info.state === "error" ? { failed: true } : {}),
    ...(info.since !== undefined ? { since: info.since } : {}),
    // The renderer put it on a line; one of only white space is an empty one.
    ...(info.message !== undefined ? { last: oneLine(info.message) } : {}),
    ...(info.profile ? { profile: info.profile } : {}),
    ...(info.cwd ? { cwd: info.cwd } : {}),
    ...(info.state === "asking" && info.waiting
      ? { waiting: { kind: info.waiting.kind, text: oneLine(info.waiting.text) } }
      : {}),
    ...(info.limitResume?.state === "waiting" && info.limitResume.at !== undefined
      ? { limitWait: { at: info.limitResume.at } }
      : {}),
    ...agentsField(services, workspaceId, tab.id),
  };
  return { row, ...(row.waiting && info.waitingId ? { waitingId: info.waitingId } : {}) };
}

function terminalSession(
  services: CliServices,
  workspaceId: string,
  tab: CliSessionTab,
  now: number,
): RemoteSession {
  const claude = services.claudeStatus(workspaceId, tab.id);
  const state = describeTerminal(claude, services.activity(workspaceId, tab.id), tab.title, now);
  const agent = isAgentSession(state) ? (state.agent ?? "agent") : undefined;
  const status = agent ? (tab.dead ? "ended" : terminalSessionState(state.state)) : "idle";
  const ask = tab.dead ? undefined : terminalAsk(services, workspaceId, tab.id, claude?.status);
  return {
    workspaceId,
    tabId: tab.id,
    kind: "terminal",
    title: tab.title,
    state: status,
    ...(state.state === "error" ? { failed: true } : {}),
    ...(agent ? { agent } : {}),
    ...(state.since !== undefined ? { since: state.since } : {}),
    ...(state.message ? { last: oneLine(state.message) } : {}),
    ...(ask
      ? {
          waiting: {
            kind: "permission",
            text: oneLine(ask.target ? `${ask.tool} ${ask.target}` : ask.tool),
            requestId: ask.id,
            always: ask.always.length > 0,
            subagent: ask.agentId !== undefined,
          },
        }
      : {}),
    ...(tab.dead ? {} : agentsField(services, workspaceId, tab.id)),
  };
}

function terminalAsk(
  services: CliServices,
  workspaceId: string,
  tabId: string,
  status: string | undefined,
) {
  return status === "permissionPending" ? services.claudeAsks(workspaceId, tabId)[0] : undefined;
}

/** The workspaces and their sessions, using task Git facts from the cache. */
export async function listSessions(
  services: CliServices,
  git?: WorkspaceGit,
): Promise<RpcResult<"sessions.list">> {
  return (await snapshotSessions(services, git)).list;
}

/** Returns the workspace and session snapshot with the requester's consents. */
export async function serveSessionsList(
  services: CliServices,
  git: WorkspaceGit | undefined,
  notes: RemoteNotes | undefined,
  from: string,
  controls: ConsentControls,
): Promise<RpcResult<"sessions.list">> {
  const snapshot = await snapshotSessions(services, git, notes, "sessions.list", from);
  return snapshot.forDevice(controls);
}

export async function reorderSessions(
  services: CliServices,
  params: RpcParams<"sessions.reorder">,
): Promise<RpcResult<"sessions.reorder">> {
  const notFound = () => new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  if (!workspaceOf(services, params.workspaceId)) throw notFound();
  const { found } = await services.ui("agentView.reorderSessions", params).catch(unavailable);
  if (!found) throw notFound();
  return {};
}

/** A snapshot whose renderer reads can also supply consent titles for each watcher. */
export async function snapshotSessions(
  services: CliServices,
  git: WorkspaceGit | undefined,
  notes?: RemoteNotes,
  method: "sessions.list" | "sessions.watch" = "sessions.watch",
  from?: string,
  includeWaitingIds = false,
) {
  const budget = new ReadBudget(services, method, from);
  const workspaces = ordered(services.listWorkspaces());
  // Read Git facts with the workspace snapshot. Waiting for tabs first would
  // let an old list recreate the cache entry for a workspace removed meanwhile.
  const listed: RemoteWorkspace[] = workspaces.map((w) => {
    const facts = w.task ? git?.(w) : undefined;
    return {
      id: w.id,
      name: w.name,
      path: w.rootPath,
      ...(w.task ? { parentId: w.task.parentId } : {}),
      ...(!w.task && w.pinned ? { pinned: true } : {}),
      ...(facts ? { git: facts } : {}),
    };
  });
  const now = Date.now();
  const read = await readRenderer(
    services,
    budget,
    workspaces.map(({ id }) => id),
  );

  const incompleteWorkspaces = new Set<string>();
  const tabsByWorkspace = new Map<string, readonly CliSessionTab[]>();
  const sessions: (RemoteSession | undefined)[] = [];
  const waitingIds = new Map<number, string>();
  const chats: { index: number; workspaceId: string; tab: CliSessionTab }[] = [];
  for (const [index, { id: workspaceId }] of workspaces.entries()) {
    const tabs = read.tabs[index];
    if (!tabs) {
      incompleteWorkspaces.add(workspaceId);
      continue;
    }
    tabsByWorkspace.set(workspaceId, tabs);
    for (const tab of tabs) {
      if (tab.type === "claude" || tab.type === "codex") {
        chats.push({ index: sessions.length, workspaceId, tab });
        sessions.push(undefined);
      } else if (tab.type === "terminal" && !tab.unstarted) {
        sessions.push(terminalSession(services, workspaceId, tab, now));
      }
    }
  }
  for (const { index, workspaceId, tab } of chats) {
    const result = chatSession(services, workspaceId, tab);
    sessions[index] = result?.row;
    if (includeWaitingIds && result?.waitingId) waitingIds.set(index, result.waitingId);
  }
  for (const { index, workspaceId } of chats) {
    if (!sessions[index]) incompleteWorkspaces.add(workspaceId);
  }
  const unread = read.unread;
  const recording = notes?.recording();
  const list: RpcResult<"sessions.list"> = {
    workspaces: listed,
    sessions: sessions
      .filter((row) => row !== undefined)
      .map((row) => {
        if (!unread || (row.state !== "idle" && row.state !== "new-result")) return row;
        const since = unread[row.workspaceId]?.[row.tabId];
        if (
          !row.failed &&
          !row.limitWait &&
          !row.waiting &&
          since !== undefined &&
          Number.isFinite(since)
        )
          return { ...row, state: "new-result", since };
        return row.state === "new-result" ? { ...row, state: "idle" } : row;
      }),
    ...(incompleteWorkspaces.size > 0 ? { incompleteWorkspaces: [...incompleteWorkspaces] } : {}),
    ...(recording ? { recording } : {}),
  };
  const waitingRequests = includeWaitingIds
    ? sessions.flatMap((row, index) => {
        if (!row?.waiting) return [];
        const { workspaceId, tabId, kind } = row;
        const id = row.waiting.requestId ?? waitingIds.get(index);
        if (!id) return [];
        // Terminal asks live in main and may have settled during the chat reads.
        if (
          kind === "terminal" &&
          terminalAsk(
            services,
            workspaceId,
            tabId,
            services.claudeStatus(workspaceId, tabId)?.status,
          )?.id !== id
        )
          return [];
        return [{ workspaceId, key: JSON.stringify([workspaceId, tabId, kind, id]) }];
      })
    : [];
  budget.report();
  return {
    list,
    incompleteWorkspaces,
    waitingRequests,
    async forDevice(controls: ConsentControls): Promise<RpcResult<"sessions.list">> {
      // Titles are optional. Reuse the bounded tab reads, even if some are missing.
      const consents = await remoteConsents(
        services,
        controls,
        Date.now(),
        async (id) => tabsByWorkspace.get(id) ?? [],
      );
      return { ...list, consents };
    },
  };
}

/** A task's git facts as last looked at; none for a workspace that is no task, or not looked at yet. */
export type WorkspaceGit = (workspace: WorkspaceMeta) => RemoteWorkspace["git"] | undefined;

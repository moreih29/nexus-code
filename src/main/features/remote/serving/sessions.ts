import {
  MAX_AGENT_DESCRIPTION,
  MAX_SESSION_AGENTS,
  type RemoteSession,
  type RemoteSessionAgent,
  type RemoteWorkspace,
  type RpcResult,
  type SessionState,
} from "../../../../../packages/remote-protocol/src";
import type { AgentRun } from "../../../../shared/claude/activity";
import type { CliChatState, CliTabInfo } from "../../../../shared/cli/ui";
import { describeTerminal, isAgentSession } from "../../../../shared/sessions/agent-state";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { compareWorkspaceOrder } from "../../../../shared/workspace-order";
import type { CliServices } from "../../cli/context";
import { type ConsentControls, remoteConsents } from "../consents";
import type { RemoteNotes } from "../notes";
import { oneLine } from "./common";
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

const MAX_CONCURRENT_UI_READS = 8;

/** Keeps renderer requests bounded and puts their results back in input order. */
async function gather<T, R>(
  items: readonly T[],
  budget: ReadBudget,
  read: (item: T) => Promise<R>,
) {
  const results: (R | undefined)[] = Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && budget.remaining() > 0) {
      const index = next++;
      results[index] = await read(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(items.length, MAX_CONCURRENT_UI_READS) }, worker),
  );
  return { results, skipped: items.length - next };
}

async function chatSession(
  services: CliServices,
  budget: ReadBudget,
  workspaceId: string,
  tab: CliTabInfo,
): Promise<RemoteSession | undefined> {
  if (tab.type !== "claude" && tab.type !== "codex") return undefined;
  const info = await budget
    .ui("chat.state", { workspaceId, tabId: tab.id, peek: true })
    .catch(() => undefined);
  // The protocol has no unknown chat state. Leave the row out until it can be read.
  if (!info) return undefined;
  return {
    workspaceId,
    tabId: tab.id,
    kind: tab.type,
    title: tab.title,
    state: CHAT_STATES[info.state],
    ...(info.since !== undefined ? { since: info.since } : {}),
    ...(info.message ? { last: oneLine(info.message) } : {}),
    ...(info.profile ? { profile: info.profile } : {}),
    ...(info.cwd ? { cwd: info.cwd } : {}),
    ...(info.state === "asking" && info.waiting
      ? { waiting: { kind: info.waiting.kind, text: oneLine(info.waiting.text) } }
      : {}),
    ...agentsField(services, workspaceId, tab.id),
  };
}

function terminalSession(
  services: CliServices,
  workspaceId: string,
  tab: CliTabInfo,
  now: number,
): RemoteSession {
  const claude = services.claudeStatus(workspaceId, tab.id);
  const state = describeTerminal(claude, services.activity(workspaceId, tab.id), tab.title, now);
  const ask =
    claude?.status === "permissionPending"
      ? services.claudeAsks(workspaceId, tab.id)[0]
      : undefined;
  return {
    workspaceId,
    tabId: tab.id,
    kind: "terminal",
    title: tab.title,
    state: isAgentSession(state) ? terminalSessionState(state.state) : "idle",
    ...(isAgentSession(state) ? { agent: state.agent ?? "agent" } : {}),
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
    ...agentsField(services, workspaceId, tab.id),
  };
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
  return snapshot.forDevice(from, controls);
}

/** A snapshot whose renderer reads can also supply consent titles for each watcher. */
export async function snapshotSessions(
  services: CliServices,
  git: WorkspaceGit | undefined,
  notes?: RemoteNotes,
  method: "sessions.list" | "sessions.watch" = "sessions.watch",
  from?: string,
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
  const tabs = await gather(workspaces, budget, async ({ id: workspaceId }) => {
    const result = await budget.ui("tabs.list", { workspaceId }).catch(() => undefined);
    return { workspaceId, tabs: result?.tabs ?? [] };
  });

  const tabsByWorkspace = new Map<string, readonly CliTabInfo[]>();
  const sessions: (RemoteSession | undefined)[] = [];
  const chats: { index: number; workspaceId: string; tab: CliTabInfo }[] = [];
  for (const entry of tabs.results) {
    if (!entry) continue;
    const { workspaceId, tabs } = entry;
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
  const chatReads = await gather(chats, budget, async ({ index, workspaceId, tab }) => {
    sessions[index] = await chatSession(services, budget, workspaceId, tab);
  });
  const recording = notes?.recording();
  const list: RpcResult<"sessions.list"> = {
    workspaces: listed,
    sessions: sessions.filter((row) => row !== undefined),
    ...(recording ? { recording } : {}),
  };
  budget.report(tabs.skipped + chatReads.skipped);
  return {
    list,
    async forDevice(
      deviceId: string,
      controls: ConsentControls,
    ): Promise<RpcResult<"sessions.list">> {
      // Titles are optional. Reuse the bounded tab reads, even if some are missing.
      const consents = await remoteConsents(
        services,
        deviceId,
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

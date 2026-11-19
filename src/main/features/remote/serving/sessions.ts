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
import type { CliChatState } from "../../../../shared/cli/ui";
import { describeTerminal, isAgentSession } from "../../../../shared/sessions/agent-state";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { compareWorkspaceOrder } from "../../../../shared/workspace-order";
import type { CliServices } from "../../cli/context";
import { type ConsentControls, remoteConsents } from "../consents";
import type { RemoteNotes } from "../notes";
import { oneLine } from "./common";

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

/**
 * The workspaces and their sessions; a task's git facts from `git`, which
 * looks at them now and then rather than now.
 */
export async function listSessions(
  services: CliServices,
  git?: WorkspaceGit,
): Promise<RpcResult<"sessions.list">> {
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
  const sessions: RemoteSession[] = [];
  const now = Date.now();
  for (const workspace of workspaces) {
    let tabs: Awaited<ReturnType<typeof services.ui<"tabs.list">>>["tabs"];
    try {
      tabs = (await services.ui("tabs.list", { workspaceId: workspace.id })).tabs;
    } catch {
      // A workspace the renderer does not hold (not opened yet): nothing to list.
      continue;
    }
    for (const tab of tabs) {
      if (tab.type === "claude" || tab.type === "codex") {
        const info = await services
          .ui("chat.state", { workspaceId: workspace.id, tabId: tab.id, peek: true })
          .catch(() => null);
        if (!info) continue;
        sessions.push({
          workspaceId: workspace.id,
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
          ...agentsField(services, workspace.id, tab.id),
        });
      } else if (tab.type === "terminal" && !tab.unstarted) {
        // One not started has nothing to show another device until its workspace is opened here.
        const claude = services.claudeStatus(workspace.id, tab.id);
        const state = describeTerminal(
          claude,
          services.activity(workspace.id, tab.id),
          tab.title,
          now,
        );
        // A Claude Code there asking to run a tool: what it asks, as the app holds it.
        const ask =
          claude?.status === "permissionPending"
            ? services.claudeAsks(workspace.id, tab.id)[0]
            : undefined;
        sessions.push({
          workspaceId: workspace.id,
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
                  kind: "permission" as const,
                  text: oneLine(ask.target ? `${ask.tool} ${ask.target}` : ask.tool),
                  requestId: ask.id,
                  always: ask.always.length > 0,
                  subagent: ask.agentId !== undefined,
                },
              }
            : {}),
          ...agentsField(services, workspace.id, tab.id),
        });
      }
    }
  }
  return { workspaces: listed, sessions };
}

/** Returns the workspace and session snapshot with the requester's consents. */
export async function serveSessionsList(
  s: CliServices,
  git: WorkspaceGit | undefined,
  notes: RemoteNotes | undefined,
  from: string,
  controls: ConsentControls,
) {
  const list = await listSessions(s, git);
  const recording = notes?.recording();
  return {
    ...list,
    consents: await remoteConsents(s, from, controls),
    ...(recording ? { recording } : {}),
  };
}

/** A task's git facts as last looked at; none for a workspace that is no task, or not looked at yet. */
export type WorkspaceGit = (workspace: WorkspaceMeta) => RemoteWorkspace["git"] | undefined;

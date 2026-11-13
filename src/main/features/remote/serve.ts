/**
 * What this device serves the account's other devices: its sessions, with
 * the same services the nexus CLI uses, so the remote sees what `nexus
 * session list` would.
 */
import {
  type Capability,
  type RemoteSession,
  type RemoteWorkspace,
  RpcErrorCode,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type SessionState,
} from "../../../../packages/remote-protocol/src";
import type { CliChatState } from "../../../shared/cli/ui";
import { describeTerminal, isAgentSession } from "../../../shared/sessions/agent-state";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { CliServices } from "../cli/context";
import { RpcFailure } from "./room";

/** What this version serves; a hello says so, and the others ask for nothing more. */
export const SERVES: readonly Capability[] = ["sessions", "chat.read", "terminal.read"];

/** How many lines of a terminal a read gives when it does not say. */
export const DEFAULT_TERMINAL_LINES = 1000;

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

/** The workspaces as the app lists them: roots, each followed by its task worktrees. */
function ordered(workspaces: readonly WorkspaceMeta[]): WorkspaceMeta[] {
  const roots = workspaces.filter((w) => !w.task);
  const out: WorkspaceMeta[] = [];
  for (const root of roots)
    out.push(root, ...workspaces.filter((w) => w.task?.parentId === root.id));
  for (const w of workspaces) if (!out.includes(w)) out.push(w);
  return out;
}

function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export async function listSessions(services: CliServices): Promise<RpcResult<"sessions.list">> {
  const workspaces = ordered(services.listWorkspaces());
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
          ...(info.state === "asking" && info.request
            ? { waiting: { kind: "permission" as const, text: oneLine(info.request.input) } }
            : {}),
        });
      } else if (tab.type === "terminal") {
        const state = describeTerminal(
          services.claudeStatus(workspace.id, tab.id),
          services.activity(workspace.id, tab.id),
          tab.title,
          now,
        );
        sessions.push({
          workspaceId: workspace.id,
          tabId: tab.id,
          kind: "terminal",
          title: tab.title,
          state: isAgentSession(state) ? terminalSessionState(state.state) : "idle",
          ...(state.since !== undefined ? { since: state.since } : {}),
          ...(state.message ? { last: oneLine(state.message) } : {}),
        });
      }
    }
  }
  const listed: RemoteWorkspace[] = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    path: w.rootPath,
  }));
  return { workspaces: listed, sessions };
}

/** The tab, when the workspace holds one of that kind; else NotFound. */
async function tabOf(
  services: CliServices,
  workspaceId: string,
  tabId: string,
  kinds: readonly string[],
): Promise<void> {
  if (!services.listWorkspaces().some((w) => w.id === workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  const { tabs } = await services
    .ui("tabs.list", { workspaceId })
    .catch(() => ({ tabs: [] as { id: string; type: string }[] }));
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || !kinds.includes(tab.type)) {
    throw new RpcFailure(RpcErrorCode.NotFound, `no such ${kinds.join(" or ")} tab`);
  }
}

/** A failure of the app's to do it, as another device is told it. */
function unavailable(error: unknown): never {
  throw new RpcFailure(
    RpcErrorCode.Unavailable,
    error instanceof Error ? error.message : String(error),
  );
}

export async function readChat(
  services: CliServices,
  { workspaceId, tabId, before, limit }: RpcParams<"chat.read">,
): Promise<RpcResult<"chat.read">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return services
    .ui("chat.page", {
      workspaceId,
      tabId,
      ...(before !== undefined ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
    })
    .catch(unavailable);
}

export async function readTerminal(
  services: CliServices,
  { workspaceId, tabId, lines }: RpcParams<"terminal.read">,
): Promise<RpcResult<"terminal.read">> {
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  return services
    .ui("terminal.read", { workspaceId, tabId, lines: lines ?? DEFAULT_TERMINAL_LINES })
    .catch(unavailable);
}

/** Answers another device's request with this device's services. */
export function serveWith(services: () => CliServices | null) {
  return async (request: { from: string; method: RpcMethod; params: unknown }) => {
    const s = services();
    if (!s) throw new RpcFailure(RpcErrorCode.Unavailable, "the app is still starting");
    switch (request.method) {
      case "sessions.list":
        return listSessions(s);
      case "chat.read":
        return readChat(s, request.params as RpcParams<"chat.read">);
      case "terminal.read":
        return readTerminal(s, request.params as RpcParams<"terminal.read">);
      default:
        throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
    }
  };
}

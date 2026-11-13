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
import type { CliChatChoices, CliChatState } from "../../../shared/cli/ui";
import { isManagerWorkspace } from "../../../shared/manager/manager";
import { describeTerminal, isAgentSession } from "../../../shared/sessions/agent-state";
import { CHAT_MODES, chatModeNamed } from "../../../shared/sessions/chat-modes";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { tryGetMainT } from "../../i18n";
import type { CliServices } from "../cli/context";
import type { ChatWatches } from "./chat-watches";
import { fitsInFrame, RpcFailure } from "./room";
import type { SessionWatches } from "./session-watches";
import type { TerminalWatches } from "./terminal-watches";

/** What this version serves; a hello says so, and the others ask for nothing more. */
export const SERVES: readonly Capability[] = [
  "sessions",
  "chat.read",
  "chat.control",
  "terminal.read",
];

/**
 * What this device serves as the user set it: its chats' controls only
 * when the user lets other devices control them (Settings › Remote); else
 * they may only look.
 */
export function servesWith(allowControl: boolean): readonly Capability[] {
  return allowControl ? SERVES : SERVES.filter((c) => c !== "chat.control");
}

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

/** A task's git facts as last looked at; none for a workspace that is no task, or not looked at yet. */
export type WorkspaceGit = (workspace: WorkspaceMeta) => RemoteWorkspace["git"] | undefined;

/**
 * The workspaces and their sessions, the agent manager's last; a task's
 * git facts from `git`, which looks at them now and then rather than now.
 */
export async function listSessions(
  services: CliServices,
  git?: WorkspaceGit,
): Promise<RpcResult<"sessions.list">> {
  const manager = services.managerWorkspace();
  const workspaces = [...ordered(services.listWorkspaces()), ...(manager ? [manager] : [])];
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
          ...(info.state === "asking" && info.waiting
            ? { waiting: { kind: info.waiting.kind, text: oneLine(info.waiting.text) } }
            : {}),
        });
      } else if (tab.type === "terminal") {
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
          ...(state.since !== undefined ? { since: state.since } : {}),
          ...(state.message ? { last: oneLine(state.message) } : {}),
          ...(ask
            ? {
                waiting: {
                  kind: "permission" as const,
                  text: oneLine(ask.target ? `${ask.tool} ${ask.target}` : ask.tool),
                  requestId: ask.id,
                },
              }
            : {}),
        });
      }
    }
  }
  const listed: RemoteWorkspace[] = workspaces.map((w) => {
    const facts = w.task ? git?.(w) : undefined;
    return {
      id: w.id,
      name: w.name,
      path: w.rootPath,
      ...(w.task ? { parentId: w.task.parentId } : {}),
      ...(isManagerWorkspace(w.id) ? { manager: true } : {}),
      ...(facts ? { git: facts } : {}),
    };
  });
  return { workspaces: listed, sessions };
}

/** The tab, when the workspace holds one of that kind; else NotFound. */
export async function tabOf(
  services: CliServices,
  workspaceId: string,
  tabId: string,
  kinds: readonly string[],
): Promise<{ id: string; type: string; title: string }> {
  if (!workspaceOf(services, workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  const { tabs } = await services
    .ui("tabs.list", { workspaceId })
    .catch(() => ({ tabs: [] as { id: string; type: string; title: string }[] }));
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || !kinds.includes(tab.type)) {
    throw new RpcFailure(RpcErrorCode.NotFound, `no such ${kinds.join(" or ")} tab`);
  }
  return tab;
}

/** A workspace the sessions' list shows: the user's, or the agent manager's. */
export function workspaceOf(services: CliServices, workspaceId: string): WorkspaceMeta | undefined {
  const manager = services.managerWorkspace();
  return (
    services.listWorkspaces().find((w) => w.id === workspaceId) ??
    (manager?.id === workspaceId ? manager : undefined)
  );
}

/**
 * The app failing or refusing to do it as the session stands (nothing to
 * stop, a request answered since), as another device is told it.
 */
export function unavailable(error: unknown): never {
  throw new RpcFailure(
    RpcErrorCode.Unavailable,
    error instanceof Error ? error.message : String(error),
  );
}

/** How many items a chat read gives when it does not say (the renderer's default too). */
export const DEFAULT_READ_ITEMS = 200;

/** Room left in a frame for the answer's envelope around a result. */
const ENVELOPE_BYTES = 1024;

export function fitsAsResult(result: unknown): boolean {
  return fitsInFrame({ result, pad: "x".repeat(ENVELOPE_BYTES) });
}

/**
 * A page of the chat, of up to `limit` items: fewer when that many would
 * not go in one frame (long tool results, a long reply), down to one item.
 */
export async function readChat(
  services: CliServices,
  { workspaceId, tabId, before, limit }: RpcParams<"chat.read">,
): Promise<RpcResult<"chat.read">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  let count = limit ?? DEFAULT_READ_ITEMS;
  for (;;) {
    const page = await services
      .ui("chat.page", {
        workspaceId,
        tabId,
        ...(before !== undefined ? { before } : {}),
        limit: count,
      })
      .catch(unavailable);
    if (fitsAsResult(page)) return page;
    if (page.items.length <= 1) {
      throw new RpcFailure(RpcErrorCode.Unavailable, "that part of the chat is too large to send");
    }
    count = Math.max(1, Math.floor(page.items.length / 2));
  }
}

export async function readTerminal(
  services: CliServices,
  { workspaceId, tabId, lines }: RpcParams<"terminal.read">,
): Promise<RpcResult<"terminal.read">> {
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  const { text } = await services
    .ui("terminal.read", { workspaceId, tabId, lines: lines ?? DEFAULT_TERMINAL_LINES })
    .catch(unavailable);
  // The end of it, as much as goes in a frame.
  let shown = text;
  while (!fitsAsResult({ text: shown })) shown = shown.slice(Math.floor(shown.length / 4));
  return { text: shown };
}

/*
 * The chat's controls, as its composer, request card, stop button and tab
 * do: the device asking is the user's own, holding the account key, so
 * what it sends is the user's, not an agent's.
 */

export async function sendChat(
  services: CliServices,
  { workspaceId, tabId, text }: RpcParams<"chat.send">,
): Promise<RpcResult<"chat.send">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("chat.send", { workspaceId, tabId, text, user: true }).catch(unavailable);
  return {};
}

export async function answerChat(
  services: CliServices,
  {
    workspaceId,
    tabId,
    requestId,
    decision,
    message,
    updatedInput,
    stop,
  }: RpcParams<"chat.answer">,
): Promise<RpcResult<"chat.answer">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services
    .ui("chat.answer", {
      workspaceId,
      tabId,
      decision,
      expect: requestId,
      ...(message !== undefined ? { message } : {}),
      ...(updatedInput ? { updatedInput } : {}),
      ...(stop ? { stop } : {}),
    })
    .catch(unavailable);
  return {};
}

/** What a tab's choices are, as the protocol tells them; the modes named in this app's language. */
export function settingsOf(choices: CliChatChoices): RpcResult<"chat.settings"> {
  const set = CHAT_MODES[choices.agent];
  const t = tryGetMainT();
  return {
    agent: choices.agent,
    model: choices.model,
    effort: choices.effort,
    permissionMode: choices.mode,
    options: {
      models: choices.models.map((m) => ({ id: m.value, label: m.name })),
      efforts: [...choices.efforts],
      modes: set.modes.map((id) => ({
        id,
        label: t ? String(t(`common:${set.prefix}.${id}`)) : id,
        ...(id === set.dangerous ? { dangerous: true } : {}),
      })),
    },
  };
}

export async function chatSettings(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.settings">,
): Promise<RpcResult<"chat.settings">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const choices = await services
    .ui("chat.settings", { workspaceId, tabId, settings: {} })
    .catch(unavailable);
  return settingsOf(choices);
}

/**
 * Sets what the user asked from another device, as the composer's chips
 * do: the mode that lets everything run too, unless a policy keeps it off
 * here (Forbidden, with why).
 */
export async function configureChat(
  services: CliServices,
  { workspaceId, tabId, model, effort, permissionMode }: RpcParams<"chat.configure">,
): Promise<RpcResult<"chat.configure">> {
  const tab = await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const settings = {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { mode: permissionMode } : {}),
  };
  if (permissionMode !== undefined) {
    const set = CHAT_MODES[tab.type as ChatAgent];
    if (chatModeNamed(tab.type as ChatAgent, permissionMode) === set.dangerous) {
      const now = await services
        .ui("chat.settings", { workspaceId, tabId, settings: {} })
        .catch(unavailable);
      if (now.dangerousBlocked) {
        throw new RpcFailure(
          RpcErrorCode.Forbidden,
          `${set.dangerous} is turned off on this computer: ${now.dangerousBlocked}`,
        );
      }
    }
  }
  const choices = await services
    .ui("chat.settings", { workspaceId, tabId, settings, user: true }, SETTINGS_TIMEOUT_MS)
    .catch(unavailable);
  return settingsOf(choices);
}

/** How long a change of settings may take: a model change restarts nothing, but waits to be shown. */
const SETTINGS_TIMEOUT_MS = 60_000;

export async function interruptChat(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.interrupt">,
): Promise<RpcResult<"chat.interrupt">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("chat.interrupt", { workspaceId, tabId }).catch(unavailable);
  return {};
}

export async function newChat(
  services: CliServices,
  { workspaceId, agent, prompt, model, effort }: RpcParams<"chat.new">,
): Promise<RpcResult<"chat.new">> {
  const workspace = workspaceOf(services, workspaceId);
  if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  const settings = {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
  const opened = await services
    .ui("chat.open", {
      workspaceId,
      agent,
      cwd: workspace.rootPath,
      prompt: prompt ?? "",
      // Behind what the window shows: whoever sits at this computer keeps their place.
      placement: { background: true },
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
    })
    .catch(unavailable);
  return { tabId: opened.tabId, ...(opened.error ? { error: opened.error } : {}) };
}

export async function closeChat(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.close">,
): Promise<RpcResult<"chat.close">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("tab.close", { workspaceId, tabId, force: false }).catch(unavailable);
  return {};
}

/** Answers another device's request with this device's services. */
export function serveWith(
  services: () => CliServices | null,
  watches: {
    chats?: ChatWatches;
    sessions?: SessionWatches;
    terminals?: TerminalWatches;
    /** The tasks' git facts the sessions' list tells. */
    git?: WorkspaceGit;
  } = {},
) {
  const { chats, sessions, terminals, git } = watches;
  return async (request: { from: string; method: RpcMethod; params: unknown }) => {
    const s = services();
    if (!s) throw new RpcFailure(RpcErrorCode.Unavailable, "the app is still starting");
    const { from, method, params } = request;
    if (sessions && method === "sessions.watch") return sessions.watch(from);
    if (sessions && method === "sessions.unwatch") {
      return sessions.unwatch(from, params as RpcParams<"sessions.unwatch">);
    }
    if (chats && method === "chat.watch") {
      return chats.watch(from, params as RpcParams<"chat.watch">);
    }
    if (chats && method === "chat.unwatch") {
      return chats.unwatch(from, params as RpcParams<"chat.unwatch">);
    }
    if (terminals && method === "terminal.watch") {
      return terminals.watch(from, params as RpcParams<"terminal.watch">);
    }
    if (terminals && method === "terminal.unwatch") {
      return terminals.unwatch(from, params as RpcParams<"terminal.unwatch">);
    }
    switch (request.method) {
      case "sessions.list":
        return listSessions(s, git);
      case "chat.read":
        return readChat(s, request.params as RpcParams<"chat.read">);
      case "terminal.read":
        return readTerminal(s, request.params as RpcParams<"terminal.read">);
      case "chat.send":
        return sendChat(s, request.params as RpcParams<"chat.send">);
      case "chat.answer":
        return answerChat(s, request.params as RpcParams<"chat.answer">);
      case "chat.interrupt":
        return interruptChat(s, request.params as RpcParams<"chat.interrupt">);
      case "chat.settings":
        return chatSettings(s, request.params as RpcParams<"chat.settings">);
      case "chat.configure":
        return configureChat(s, request.params as RpcParams<"chat.configure">);
      case "chat.new":
        return newChat(s, request.params as RpcParams<"chat.new">);
      case "chat.close":
        return closeChat(s, request.params as RpcParams<"chat.close">);
      default:
        throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
    }
  };
}

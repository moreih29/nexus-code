/**
 * What this device serves the account's other devices: its sessions, with
 * the same services the nexus CLI uses, so the remote sees what `nexus
 * session list` would.
 */
import {
  type AgentSender,
  type Capability,
  type RemoteSession,
  type RemoteWorkspace,
  RpcErrorCode,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type SessionState,
} from "../../../../packages/remote-protocol/src";
import type { RelaySender } from "../../../shared/chat/relay";
import type { CliChatChoices, CliChatState } from "../../../shared/cli/ui";
import { isManagerWorkspace } from "../../../shared/manager/manager";
import { describeTerminal, isAgentSession } from "../../../shared/sessions/agent-state";
import { CHAT_MODES, chatModeNamed } from "../../../shared/sessions/chat-modes";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { tryGetMainT } from "../../i18n";
import type { CliServices } from "../cli/context";
import type { FsProvider } from "../fs/bridge/provider";
import { type AgentGate, type AgentRequest, relaySenderOf } from "./agent-gate";
import { Attachments } from "./attachments";
import type { ChatWatches } from "./chat-watches";
import { answerConsent, type ConsentControls, remoteConsents } from "./consents";
import { folderIn, listFiles, type RemoteFiles, readFile } from "./files";
import { gitDiff, gitLog, gitShow, gitStatus, type RemoteGit } from "./git";
import { attachToNote, listNotes, PhotoQuota, type RemoteNotes } from "./notes";
import { fitsInFrame, MAX_MESSAGE_BYTES, RpcFailure } from "./room";
import { findFiles, searchFiles } from "./search";
import type { SessionWatches } from "./session-watches";
import {
  answerTerminal,
  closeTerminal,
  inputTerminal,
  openTerminal,
  renameTerminal,
  terminalShells,
} from "./terminal-control";
import type { TerminalWatches } from "./terminal-watches";
import { waitOnChat, waitOnTerminalFor } from "./waits";

/** What this version serves; a hello says so, and the others ask for nothing more. */
export const SERVES: readonly Capability[] = [
  "sessions",
  "chat.read",
  "chat.control",
  "terminal.read",
  "terminal.control",
  "files",
  "git",
  "notes",
  "agents",
];

/**
 * What this device serves as the user set it: its chats' controls, and
 * its terminals', each only when the user lets other devices have them
 * (Settings › Remote), else they may only look; agents' requests unless
 * the user turned them down.
 */
export function servesWith(
  allowControl: boolean,
  allowTerminal = false,
  allowAgents = false,
): readonly Capability[] {
  return SERVES.filter(
    (c) =>
      (c !== "chat.control" || allowControl) &&
      (c !== "terminal.control" || allowTerminal) &&
      (c !== "agents" || allowAgents),
  );
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
  { workspaceId, tabId, lines, ansi }: RpcParams<"terminal.read">,
): Promise<RpcResult<"terminal.read">> {
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  const { text } = await services
    .ui("terminal.read", {
      workspaceId,
      tabId,
      lines: lines ?? DEFAULT_TERMINAL_LINES,
      ...(ansi ? { ansi } : {}),
    })
    .catch(unavailable);
  // The end of it, as much as goes in a frame, from a line's start: no escape cut in two.
  let shown = text;
  while (!fitsAsResult({ text: shown })) {
    const cut = shown.slice(Math.floor(shown.length / 4));
    const line = cut.indexOf("\n");
    shown = line >= 0 ? cut.slice(line + 1) : cut;
  }
  return { text: shown };
}

/*
 * The chat's controls, as its composer, request card, stop button and tab
 * do: the device asking is the user's own, holding the account key, so
 * what it sends is the user's, not an agent's.
 */

/**
 * Sends the chat a message, with the images the device attached for it
 * (chat.attach), which then go; text or an image at least.
 */
export async function sendChat(
  services: CliServices,
  { workspaceId, tabId, text, attachments: ids = [] }: RpcParams<"chat.send">,
  attached?: { device: string; attachments: Attachments },
  relay?: RelaySender,
): Promise<RpcResult<"chat.send">> {
  if (!text.trim() && ids.length === 0) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "a message needs text or an image");
  }
  if (ids.length > 0 && !attached) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "no images are kept here");
  }
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const images =
    attached && ids.length > 0
      ? attached.attachments.find(attached.device, workspaceId, tabId, ids)
      : [];
  // Before it goes: what the chat shows from here on is from this message on.
  const at = services.clock.now();
  await services
    .ui("chat.send", {
      workspaceId,
      tabId,
      text,
      // An agent's shows as its, and waits while the chat asks the user something.
      ...(relay ? { from: relay } : { user: true }),
      ...(images.length > 0 ? { images } : {}),
    })
    .catch(unavailable);
  attached?.attachments.drop(ids);
  return { at };
}

/** Room an image's base64 may take in its answer: the frame, less the envelope and its other fields. */
const IMAGE_CHARS = MAX_MESSAGE_BYTES - ENVELOPE_BYTES - 256;

/** An image of the chat, drawn smaller where it would not go in a frame. */
export async function chatImage(
  services: CliServices,
  { workspaceId, tabId, ref }: RpcParams<"chat.image">,
): Promise<RpcResult<"chat.image">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const image = await services
    .ui("chat.image", { workspaceId, tabId, ref, maxChars: IMAGE_CHARS })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such image/.test(message)) throw new RpcFailure(RpcErrorCode.NotFound, message);
      return unavailable(error);
    });
  if (!fitsAsResult(image)) {
    throw new RpcFailure(RpcErrorCode.Unavailable, "the image would not go in a frame");
  }
  return image;
}

/** Keeps an image for the device's next message to the chat. */
export async function attachToChat(
  services: CliServices,
  { workspaceId, tabId, mediaType, data }: RpcParams<"chat.attach">,
  device: string,
  attachments: Attachments,
): Promise<RpcResult<"chat.attach">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return { attachmentId: attachments.take(device, workspaceId, tabId, { mediaType, data }) };
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
    always,
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
      ...(decision === "allow" && always?.length ? { always } : {}),
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
  byAgent = false,
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
    .ui(
      "chat.settings",
      // An agent never takes the mode that lets everything run.
      { workspaceId, tabId, settings, ...(byAgent ? {} : { user: true }) },
      SETTINGS_TIMEOUT_MS,
    )
    .catch(unavailable);
  return settingsOf(choices);
}

/** How long a change of settings may take: a model change restarts nothing, but waits to be shown. */
const SETTINGS_TIMEOUT_MS = 60_000;

export async function chatCommands(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.commands">,
): Promise<RpcResult<"chat.commands">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return services.ui("chat.commands", { workspaceId, tabId }).catch(unavailable);
}

/**
 * Runs one of the app's commands the tab lists, as its composer runs it
 * typed; one the agent runs goes with chat.send, and the model and effort
 * with chat.configure.
 */
export async function runChatCommand(
  services: CliServices,
  { workspaceId, tabId, name, args }: RpcParams<"chat.command">,
): Promise<RpcResult<"chat.command">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const bare = name.replace(/^\//, "");
  const { commands } = await services
    .ui("chat.commands", { workspaceId, tabId })
    .catch(unavailable);
  const command = commands.find((c) => c.name === bare);
  if (command?.runs !== "command") {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      !command
        ? `/${bare} is not a command this chat lists (chat.commands)`
        : command.runs === "send"
          ? `/${bare} is the agent's own: send it as a message (chat.send)`
          : `/${bare} sets what chat.configure sets`,
    );
  }
  return services
    .ui(
      "chat.command",
      { workspaceId, tabId, name: bare, ...(args ? { args } : {}) },
      SETTINGS_TIMEOUT_MS,
    )
    .catch(unavailable);
}

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
  {
    workspaceId,
    agent,
    prompt,
    model,
    effort,
    permissionMode,
    profile,
    folder,
  }: RpcParams<"chat.new">,
  fs?: (workspaceId: string) => Promise<FsProvider>,
  relay?: RelaySender,
): Promise<RpcResult<"chat.new">> {
  const workspace = workspaceOf(services, workspaceId);
  if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  const cwd = folder
    ? await folderIn(
        fs ? await fs(workspaceId).catch(unavailable) : null,
        workspace.rootPath,
        folder,
      )
    : workspace.rootPath;
  const settings = {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { mode: permissionMode } : {}),
  };
  const opened = await services
    .ui(
      "chat.open",
      {
        workspaceId,
        agent,
        cwd,
        prompt: prompt ?? "",
        // Behind what the window shows: whoever sits at this computer keeps their place.
        placement: { background: true },
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(profile !== undefined ? { profile } : {}),
        // An agent's prompt shows as its; its settings never the mode that lets everything run.
        ...(relay ? { from: relay } : { user: true }),
      },
      SETTINGS_TIMEOUT_MS,
    )
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/ has no profile /.test(message))
        throw new RpcFailure(RpcErrorCode.InvalidParams, message);
      return unavailable(error);
    });
  return { tabId: opened.tabId, ...(opened.error ? { error: opened.error } : {}) };
}

/** How many session changes an events.read with no `limit` reads. */
export const DEFAULT_EVENTS = 100;

/**
 * The sessions' state changes, as `nexus events` lists them: after `since`
 * (the first ones, `more` when some were left out), or the last ones. As
 * many as go in a frame, each message in a line.
 */
export async function readEvents(
  services: CliServices,
  { since, limit }: RpcParams<"events.read">,
): Promise<RpcResult<"events.read">> {
  const read = await services
    .ui("events.read", {
      ...(since !== undefined ? { since } : {}),
      limit: limit ?? DEFAULT_EVENTS,
    })
    .catch(unavailable);
  let events: RpcResult<"events.read">["events"] = read.events.map((e) => ({
    seq: e.seq,
    at: e.at,
    workspaceId: e.workspaceId,
    tabId: e.tabId,
    title: e.title,
    kind: e.kind,
    ...(e.agent ? { agent: e.agent } : {}),
    from: e.from,
    to: e.to,
    ...(e.message ? { message: oneLine(e.message, 500) } : {}),
  }));
  let more = read.more;
  while (events.length > 0 && !fitsAsResult({ events, cursor: read.cursor, more })) {
    const half = Math.ceil(events.length / 2);
    if (since === undefined) {
      // The last ones: the latest are kept.
      events = events.slice(half);
    } else {
      // After `since`: the first are kept, and the rest left for the next read.
      events = events.slice(0, events.length - half);
      more = true;
    }
  }
  return { events, cursor: read.cursor, more };
}

/** The agent profiles a new chat may run with. */
export async function listProfiles(
  services: CliServices,
  { agent }: RpcParams<"profiles.list">,
): Promise<RpcResult<"profiles.list">> {
  return services.ui("chat.profiles", agent ? { agent } : {}).catch(unavailable);
}

/** Renames the chat, as its tab's rename does. */
export async function renameChat(
  services: CliServices,
  { workspaceId, tabId, title }: RpcParams<"chat.rename">,
): Promise<RpcResult<"chat.rename">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  if (!title.trim())
    throw new RpcFailure(RpcErrorCode.InvalidParams, "a title needs more than spaces");
  return services.ui("chat.rename", { workspaceId, tabId, title }).catch(unavailable);
}

/** Most characters of a tool's result asked for: more than a frame takes anyway. */
const MAX_TOOL_TEXT = MAX_MESSAGE_BYTES;

/** One tool call, a subagent's too, with as much of its result as a frame takes. */
export async function chatTool(
  services: CliServices,
  { workspaceId, tabId, toolUseId }: RpcParams<"chat.tool">,
): Promise<RpcResult<"chat.tool">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const ask = (maxText: number) =>
    services
      .ui("chat.toolCall", { workspaceId, tabId, toolUseId, maxText })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/^no tool call /.test(message)) throw new RpcFailure(RpcErrorCode.NotFound, message);
        return unavailable(error);
      });
  let tool = await ask(MAX_TOOL_TEXT);
  // Its input, or text that escapes long in JSON: asked again with less of the result.
  for (let maxText = MAX_TOOL_TEXT / 2; !fitsAsResult(tool); maxText = Math.floor(maxText / 2)) {
    if (maxText < 1024)
      throw new RpcFailure(RpcErrorCode.Unavailable, "that call is too large to send");
    tool = await ask(maxText);
  }
  return tool;
}

/** What the chat's side panel shows; its changed files cut to what goes in a frame. */
export async function chatPanel(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.panel">,
): Promise<RpcResult<"chat.panel">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const panel = await services.ui("chat.panel", { workspaceId, tabId }).catch(unavailable);
  let { changedFiles } = panel;
  while (changedFiles.length > 0 && !fitsAsResult({ ...panel, changedFiles })) {
    changedFiles = changedFiles.slice(0, Math.floor(changedFiles.length / 2));
  }
  return { ...panel, changedFiles };
}

/** Stops one of the chat's tasks, as its panel's stop button does. */
export async function stopChatTask(
  services: CliServices,
  { workspaceId, tabId, taskId }: RpcParams<"chat.stopTask">,
): Promise<RpcResult<"chat.stopTask">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("chat.stopTask", { workspaceId, tabId, taskId }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/^no task /.test(message)) throw new RpcFailure(RpcErrorCode.NotFound, message);
    return unavailable(error);
  });
  return {};
}

/** The workspace's conversations of the past that a new chat can go on with. */
export async function listHistory(
  services: CliServices,
  { workspaceId, agent, query, limit }: RpcParams<"history.list">,
): Promise<RpcResult<"history.list">> {
  if (!workspaceOf(services, workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  const { sessions } = await services
    .ui("chat.history", {
      workspaceId,
      agent,
      ...(query ? { query } : {}),
      ...(limit ? { limit } : {}),
    })
    .catch(unavailable);
  // Long first prompts for titles: as many as go in a frame.
  let shown = sessions;
  while (shown.length > 0 && !fitsAsResult({ sessions: shown })) {
    shown = shown.slice(0, Math.floor(shown.length / 2));
  }
  return { sessions: shown };
}

/** Goes on with a conversation of the past in a new chat, behind what this computer shows. */
export async function resumeChat(
  services: CliServices,
  { workspaceId, agent, sessionId }: RpcParams<"chat.resume">,
): Promise<RpcResult<"chat.resume">> {
  if (!workspaceOf(services, workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  return services.ui("chat.resume", { workspaceId, agent, sessionId }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/^no conversation /.test(message)) throw new RpcFailure(RpcErrorCode.NotFound, message);
    return unavailable(error);
  });
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
/** Most files.find and files.search one device may have running here at once. */
export const MAX_SEARCHES_PER_DEVICE = 2;

export function serveWith(
  services: () => CliServices | null,
  watches: {
    chats?: ChatWatches;
    sessions?: SessionWatches;
    terminals?: TerminalWatches;
    /** The tasks' git facts the sessions' list tells. */
    git?: WorkspaceGit;
    /** The images devices attached for their next messages. */
    attachments?: Attachments;
    /** The workspaces' file systems, and how an image is drawn smaller. */
    files?: Omit<RemoteFiles, "folders">;
    /** The workspaces' repositories, for git.status, git.diff, git.log and git.show. */
    repositories?: RemoteGit;
    /** The workspaces' notes, for notes.list and notes.attach, and the note it records into. */
    notes?: RemoteNotes;
    /** How many photos each device put into notes lately; a fresh one when not given. */
    photoQuota?: PhotoQuota;
    /** Whether an agent on another device may do what it asks (a request with `from`). */
    agents?: AgentGate;
    /** A device of the room by its id, as it names itself. */
    deviceName?: (id: string) => string | undefined;
    /**
     * What the user lets other devices control here, for the consent prompts
     * they may answer; none when not told.
     */
    controls?: () => ConsentControls;
  } = {},
) {
  const { chats, sessions, terminals, git } = watches;
  const attachments = watches.attachments ?? new Attachments();
  const photoQuota = watches.photoQuota ?? new PhotoQuota();
  /** files.find and files.search running now, by the device that asked. */
  const searching = new Map<string, number>();
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
    // An agent's request: let through as the user set it, and shown as that agent's.
    const by = (params as { from?: AgentSender } | undefined)?.from;
    let relay: RelaySender | undefined;
    if (by) {
      if (!watches.agents) {
        throw new RpcFailure(RpcErrorCode.Forbidden, "agents' requests are not taken here");
      }
      const device = { id: from, name: watches.deviceName?.(from) ?? from.slice(0, 8) };
      await watches.agents.check(s, {
        device,
        method,
        params: params as AgentRequest["params"],
      });
      relay = relaySenderOf(by, device);
    }
    const controls = watches.controls?.() ?? { chat: false, terminal: false };
    switch (request.method) {
      case "sessions.list": {
        const list = await listSessions(s, git);
        const recording = watches.notes?.recording();
        return {
          ...list,
          consents: await remoteConsents(s, from, controls),
          ...(recording ? { recording } : {}),
        };
      }
      case "notes.list":
      case "notes.attach": {
        const notes = watches.notes;
        if (!notes) {
          throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
        }
        const { workspaceId } = request.params as { workspaceId: string };
        if (!workspaceOf(s, workspaceId)) {
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        }
        if (request.method === "notes.list") {
          return listNotes(notes, request.params as RpcParams<"notes.list">);
        }
        photoQuota.take(from);
        return attachToNote(notes, request.params as RpcParams<"notes.attach">);
      }
      case "consent.answer":
        return answerConsent(
          s,
          { id: from, name: watches.deviceName?.(from) ?? from.slice(0, 8) },
          controls,
          request.params as RpcParams<"consent.answer">,
        );
      case "chat.read":
        return readChat(s, request.params as RpcParams<"chat.read">);
      case "terminal.read":
        return readTerminal(s, request.params as RpcParams<"terminal.read">);
      case "chat.send":
        return sendChat(
          s,
          request.params as RpcParams<"chat.send">,
          { device: from, attachments },
          relay,
        );
      case "files.list":
      case "files.read": {
        if (!watches.files) {
          throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
        }
        const { workspaceId } = request.params as { workspaceId: string };
        const workspace = workspaceOf(s, workspaceId);
        if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        const files: RemoteFiles = {
          ...watches.files,
          folders: (id) =>
            s
              .ui("workspace.folders", { workspaceId: id })
              .then((r) => r.folders)
              .catch(() => []),
        };
        return request.method === "files.list"
          ? listFiles(files, workspace.rootPath, request.params as RpcParams<"files.list">)
          : readFile(files, workspace.rootPath, request.params as RpcParams<"files.read">);
      }
      case "files.find":
      case "files.search": {
        if (!watches.files) {
          throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
        }
        const { workspaceId } = request.params as { workspaceId: string };
        if (!workspaceOf(s, workspaceId)) {
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        }
        // Each runs through a workspace's files on its host: a device runs a few at once, no more.
        const running = searching.get(from) ?? 0;
        if (running >= MAX_SEARCHES_PER_DEVICE) {
          throw new RpcFailure(
            RpcErrorCode.Unavailable,
            `that device has ${running} searches running here already: ask again once one ends`,
          );
        }
        searching.set(from, running + 1);
        try {
          const fs = await watches.files.fs(workspaceId).catch(unavailable);
          return await (request.method === "files.find"
            ? findFiles(fs, request.params as RpcParams<"files.find">)
            : searchFiles(fs, request.params as RpcParams<"files.search">));
        } finally {
          const left = (searching.get(from) ?? 1) - 1;
          if (left > 0) searching.set(from, left);
          else searching.delete(from);
        }
      }
      case "git.status":
      case "git.diff":
      case "git.log":
      case "git.show": {
        const repositories = watches.repositories;
        if (!repositories) {
          throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
        }
        const { workspaceId } = request.params as { workspaceId: string };
        if (!workspaceOf(s, workspaceId)) {
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        }
        if (request.method === "git.status") {
          return gitStatus(repositories, request.params as RpcParams<"git.status">);
        }
        if (request.method === "git.show") {
          return gitShow(repositories, request.params as RpcParams<"git.show">);
        }
        return request.method === "git.diff"
          ? gitDiff(repositories, request.params as RpcParams<"git.diff">)
          : gitLog(repositories, request.params as RpcParams<"git.log">);
      }
      case "chat.image":
        return chatImage(s, request.params as RpcParams<"chat.image">);
      case "chat.attach":
        return attachToChat(s, request.params as RpcParams<"chat.attach">, from, attachments);
      case "chat.answer":
        return answerChat(s, request.params as RpcParams<"chat.answer">);
      case "chat.interrupt":
        return interruptChat(s, request.params as RpcParams<"chat.interrupt">);
      case "chat.settings":
        return chatSettings(s, request.params as RpcParams<"chat.settings">);
      case "chat.configure":
        return configureChat(s, request.params as RpcParams<"chat.configure">, relay !== undefined);
      case "chat.commands":
        return chatCommands(s, request.params as RpcParams<"chat.commands">);
      case "chat.command":
        return runChatCommand(s, request.params as RpcParams<"chat.command">);
      case "chat.new":
        return newChat(s, request.params as RpcParams<"chat.new">, watches.files?.fs, relay);
      case "chat.wait":
        return waitOnChat(s, request.params as RpcParams<"chat.wait">);
      case "terminal.wait":
        return waitOnTerminalFor(s, request.params as RpcParams<"terminal.wait">);
      case "events.read":
        return readEvents(s, request.params as RpcParams<"events.read">);
      case "profiles.list":
        return listProfiles(s, request.params as RpcParams<"profiles.list">);
      case "chat.rename":
        return renameChat(s, request.params as RpcParams<"chat.rename">);
      case "chat.tool":
        return chatTool(s, request.params as RpcParams<"chat.tool">);
      case "chat.panel":
        return chatPanel(s, request.params as RpcParams<"chat.panel">);
      case "chat.stopTask":
        return stopChatTask(s, request.params as RpcParams<"chat.stopTask">);
      case "history.list":
        return listHistory(s, request.params as RpcParams<"history.list">);
      case "chat.resume":
        return resumeChat(s, request.params as RpcParams<"chat.resume">);
      case "chat.close":
        return closeChat(s, request.params as RpcParams<"chat.close">);
      case "terminal.input":
        return inputTerminal(s, request.params as RpcParams<"terminal.input">);
      case "terminal.shells":
        return terminalShells(s, request.params as RpcParams<"terminal.shells">);
      case "terminal.open":
        return openTerminal(s, request.params as RpcParams<"terminal.open">, watches.files?.fs);
      case "terminal.rename":
        return renameTerminal(s, request.params as RpcParams<"terminal.rename">);
      case "terminal.close":
        return closeTerminal(s, request.params as RpcParams<"terminal.close">);
      case "terminal.answer":
        return answerTerminal(s, request.params as RpcParams<"terminal.answer">);
      default:
        throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
    }
  };
}

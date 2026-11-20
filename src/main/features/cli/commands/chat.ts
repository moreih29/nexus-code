/**
 * nexus chat ...: the app's Claude and Codex tabs, driven as their composer
 * drives them. A tab's conversation is the renderer's; these ask it, read it
 * whole or a piece at a time, and wait on one or several tabs.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ImageMediaTypeSchema,
  MAX_ATTACHMENT_BYTES,
  type RpcParams,
} from "../../../../../packages/remote-protocol/src";
import { INSTRUCTION_LIMIT, InstructionTextSchema } from "../../../../shared/chat/instructions";
import type {
  CliChatEntry,
  CliChatInfo,
  CliChatSettings,
  CliTabInfo,
} from "../../../../shared/cli/ui";
import { createLogger } from "../../../../shared/log/main";
import { CHAT_MODES, chatModeNamed, grants, loosens } from "../../../../shared/sessions/chat-modes";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { looksLike } from "../../remote/attachments";
import { MAX_MESSAGE_BYTES } from "../../remote/room";
import { CliUsageError, exactArgs, type ParsedArgs, parseDuration } from "../args";
import type { ChangeRequest } from "../consent";
import {
  type CliContext,
  type CliDevice,
  CliError,
  mayChange,
  placementFor,
  resolveTab,
  resolveWorkspace,
  shortId,
} from "../context";
import { oneLine } from "../format";
import { absolutePath, callerPath, onAppMachine } from "../paths";
import { type CliCommand, type CliOutput, output } from "../registry";
import {
  askPeerCli,
  changePeerCli,
  DEVICE_FLAG,
  deviceFlag,
  deviceRef,
  requirePeerCli,
  resolveDevice,
} from "../remote";
import { senderOf } from "../sender";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, WAIT_POLL_MS, type WaitResult } from "../wait";
import {
  answerPeer,
  interruptPeer,
  newPeerChat,
  peerChatTool,
  peerCliChat,
  readPeerChat,
  sendToPeer,
  setPeerChat,
  waitOnPeer,
} from "./chat-remote";
import { AGENT_NAMES, chatStateText, choicesText } from "./chat-text";
import { WORKSPACE_FLAG } from "./flags";
import { workspaceTabs } from "./terminal";

const log = createLogger("cli");

/** The agent an --agent flag names: claude or codex. */
export function chatAgentFlag(value: unknown, fallback: ChatAgent): ChatAgent {
  if (value === undefined) return fallback;
  const name = String(value).trim().toLowerCase();
  if (name === "claude" || name === "codex") return name;
  throw new CliUsageError("--agent is claude or codex");
}

/** Whether a tab is a Claude or Codex tab. */
export function isChatTab(tab: CliTabInfo): boolean {
  return tab.type === "claude" || tab.type === "codex";
}

/** The Claude or Codex tab a selector names in a workspace. */
export async function resolveChat(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  selector: string,
): Promise<CliTabInfo> {
  const tabs = (await workspaceTabs(ctx, workspace.id)).filter(isChatTab);
  return resolveTab(ctx, tabs, selector, `Claude or Codex tab in ${workspace.name}`);
}

/** What a tab runs with and works toward, a line each: its profile, its goal. */
export function chatAboutText(info: CliChatInfo): string {
  const lines: string[] = [];
  if (info.profile) lines.push(`Profile: ${info.profile}.`);
  if (info.goal) {
    const { objective, status, reason } = info.goal;
    const why = reason ? ` (${oneLine(reason, 300)})` : "";
    lines.push(`Goal, ${status}: ${oneLine(objective, 300)}${why}`);
  }
  return lines.join("\n");
}

const ROLE_LABELS: Readonly<Record<CliChatEntry["role"], string>> = {
  user: "user",
  agent: "agent",
  tool: "tool",
  notice: "note",
};

/** Cuts a message to `maxChars`, saying how much is left out. */
function cut(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [+${text.length - maxChars} chars]`;
}

/**
 * A conversation as chat read prints it: each message under who said it,
 * with its place, a tool call or a note on a line.
 */
export function chatTranscript(
  info: CliChatInfo,
  entries: readonly CliChatEntry[],
  maxChars?: number,
): string {
  return entries
    .map((entry) => {
      const label = entry.role === "agent" ? info.agent : ROLE_LABELS[entry.role];
      const sub = entry.parentToolUseId ? " (subagent)" : "";
      // A message sent during a turn that the agent has not read: chat unsend takes it back.
      const unread = entry.role === "user" && entry.status === "unread" ? " (unread)" : "";
      return entry.role === "tool" || entry.role === "notice"
        ? `[${label} #${entry.i}]${sub} ${cut(entry.text, maxChars)}`
        : `── ${label} #${entry.i}${unread}\n${cut(entry.text, maxChars)}`;
    })
    .join("\n");
}

function infoJson(
  tab: { readonly id: string; readonly title: string },
  workspaceId: string,
  info: CliChatInfo,
  device?: CliDevice,
) {
  return {
    tabId: tab.id,
    workspaceId,
    ...(device ? { device: deviceRef(device) } : {}),
    title: tab.title,
    agent: info.agent,
    state: info.state,
    ...(info.message ? { message: info.message } : {}),
    ...(info.since !== undefined ? { since: info.since } : {}),
    ...(info.profile ? { profile: info.profile } : {}),
    ...(info.goal ? { goal: info.goal } : {}),
  };
}

/** A --max-chars flag: a positive whole number, or none. */
function maxCharsFlag(flags: ParsedArgs["flags"]): number | undefined {
  const value = flags["max-chars"] as number | undefined;
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new CliUsageError("--max-chars takes a positive whole number");
  }
  return value;
}

const MAX_CHARS_FLAG = {
  type: "number",
  value: "N",
  description: "Cut each message to N characters, saying how many are left out",
} as const;

function waitTimeout(flags: ParsedArgs["flags"]): number {
  const timeoutMs =
    flags.timeout === undefined
      ? DEFAULT_WAIT_MS
      : parseDuration(flags.timeout as string, "timeout");
  if (timeoutMs > MAX_WAIT_MS) throw new CliUsageError("--timeout is at most 30m");
  return timeoutMs;
}

const TIMEOUT_FLAG = {
  type: "string",
  value: "DURATION",
  description: "Stop waiting after DURATION, such as 90s or 5m (default 10m, at most 30m)",
} as const;

/**
 * Waits until one of some Claude or Codex tabs of a workspace is done
 * working: idle after its turn, asking the user, stopped on an error, or
 * closed. Says which, as `tab`. Never throws for a timeout.
 */
export async function waitOnChats(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  tabs: readonly CliTabInfo[],
  timeoutMs: number,
  submissionId?: string,
): Promise<WaitResult & { tab?: CliTabInfo }> {
  const { clock } = ctx.services;
  const startedAt = clock.now();
  const ends = tabs.map((tab) =>
    ctx.services.waits.begin(ctx.caller, { workspaceId: workspace.id, tabId: tab.id }, startedAt),
  );
  try {
    for (;;) {
      const open = new Set((await workspaceTabs(ctx, workspace.id)).map((t) => t.id));
      for (const tab of tabs) {
        if (!open.has(tab.id)) {
          return { done: true, state: "closed", text: `${tab.title} was closed.`, tab };
        }
        const info = await ctx.services.ui("chat.state", {
          workspaceId: workspace.id,
          tabId: tab.id,
          ...(submissionId ? { submissionId } : {}),
        });
        if (info.state !== "working") {
          return {
            done: true,
            state: info.state,
            text: chatStateText(tab, info),
            ...(info.message ? { message: info.message } : {}),
            tab,
          };
        }
      }
      // A client that has gone (Ctrl-C) waits no more, nor shows as waiting.
      if (clock.now() - startedAt >= timeoutMs || ctx.signal?.aborted) {
        const which = tabs.length === 1 ? (tabs[0] as CliTabInfo).title : "every tab";
        return {
          done: false,
          state: "timeout",
          text: `${which} was still working when the wait ran out; see it with "nexus chat read".`,
        };
      }
      await clock.sleep(WAIT_POLL_MS);
    }
  } finally {
    for (const end of ends) end();
  }
}

/** Waits until a Claude or Codex tab is done working; see waitOnChats. */
export function waitOnChat(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  tab: CliTabInfo,
  timeoutMs: number,
  submissionId?: string,
): Promise<WaitResult> {
  return waitOnChats(ctx, workspace, [tab], timeoutMs, submissionId);
}

/** A wait's result as the command prints it; exit 124 when the wait ran out. */
function waitOutput(text: string, json: Record<string, unknown>, result: WaitResult): CliOutput {
  return output(
    text,
    { ...json, state: result.state, ...(result.message ? { message: result.message } : {}) },
    result.done ? {} : { exitCode: 124 },
  );
}

/** The model, effort and mode flags of chat new and chat set. */
const SETTING_FLAGS = {
  model: {
    type: "string",
    value: "MODEL",
    description: "The model, by a name its model menu lists (chat set <tab> lists them)",
  },
  effort: { type: "string", value: "LEVEL", description: "The effort, one the model takes" },
  mode: {
    type: "string",
    value: "MODE",
    description:
      "Use plan, default, acceptEdits, auto or bypassPermissions for Claude, and readOnly, auto or fullAccess for Codex",
  },
} as const;

/** What --model, --effort and --mode ask, the mode checked against the agent's. */
function settingsFlags(
  agent: ChatAgent,
  flags: ParsedArgs["flags"],
  local = false,
): CliChatSettings {
  const given = (name: string): string | undefined => {
    const value = flags[name] as string | undefined;
    if (value === undefined) return undefined;
    const text = value.trim();
    if (text === "") throw new CliUsageError(`--${name} takes a value`);
    return text;
  };
  const model = given("model");
  const effort = given("effort");
  const name = given("mode");
  let mode: string | undefined;
  if (name !== undefined) {
    const set = CHAT_MODES[agent];
    mode = chatModeNamed(agent, name);
    if (!mode) {
      const modes = local ? set.modes : set.modes.filter((m) => m !== set.dangerous);
      throw new CliUsageError(
        `${AGENT_NAMES[agent]} has no mode "${name}"; it has ${modes.join(", ")}`,
      );
    }
    if (!local && mode === set.dangerous) throw dangerousModeError(mode);
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

function dangerousModeError(mode: string): CliError {
  return new CliError(
    `${mode} lets every tool run without asking; only the user picks it, in the tab's mode menu`,
  );
}

interface CallerMode {
  readonly agent: ChatAgent;
  readonly mode?: string;
}

async function verifiedChatMode(ctx: CliContext): Promise<CallerMode | null> {
  const { workspaceId, tabId, verified } = ctx.caller;
  if (verified !== true) return null;
  const workspace = ctx.services.listWorkspaces().find((w) => w.id === workspaceId);
  if (!workspace || workspace.location.kind === "ssh") return null;
  return ctx.services.ui("chat.mode", { workspaceId, tabId }).catch(() => null);
}

function logDelegation(ctx: CliContext, tabId: string, caller: CallerMode, mode?: string): void {
  const current =
    caller.mode && CHAT_MODES[caller.agent].modes.includes(caller.mode) ? ` (${caller.mode})` : "";
  const granted = mode === undefined ? "" : ` (${mode})`;
  log.info(
    `Delegated chat permission ${shortId(ctx.caller.tabId)}${current} → ${shortId(tabId)}${granted}`,
  );
}

/**
 * Authorizes a mode change after the workspace policy. Returns the caller's
 * mode when it delegated the new mode. The unrestricted mode always needs
 * a grant, so its caller can omit the target's current mode.
 */
async function mayLoosen(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  agent: ChatAgent,
  name: string,
  to: string,
  from?: string,
): Promise<CallerMode | undefined> {
  const dangerous = to === CHAT_MODES[agent].dangerous;
  if (!dangerous && (from === undefined || !loosens(agent, from, to))) return;
  const caller = await verifiedChatMode(ctx);
  if (caller && grants(caller.agent, caller.mode, agent, to)) return caller;
  if (dangerous) throw dangerousModeError(to);
  await ctx.services.askUser({
    fromWorkspaceId: ctx.caller.workspaceId,
    fromTabId: ctx.caller.tabId,
    toWorkspaceId: workspace.id,
    change: { kind: "chatMode", detail: `${name} (${from} → ${to})` },
  });
}

export async function readInstructionsFile(ctx: CliContext, file: string): Promise<string> {
  const where = callerPath(ctx, file);
  const data = await ctx.services.readFile(ctx.caller.workspaceId, where);
  if (data === null) throw new CliError(`no file ${where}`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data, "base64"));
  } catch {
    throw new CliUsageError("the instructions file must be UTF-8 text");
  }
  return checkedInstructions(text);
}

export function checkedInstructions(text: string): string {
  if (text.length > INSTRUCTION_LIMIT)
    throw new CliUsageError(
      `instructions are limited to ${INSTRUCTION_LIMIT} characters per layer`,
    );
  if (!InstructionTextSchema.safeParse(text).success)
    throw new CliUsageError("the instructions file contains a null character");
  return text.trim() ? text : "";
}

const chatNew: CliCommand = {
  path: ["chat", "new"],
  summary: "Open a Claude or Codex tab, sending it a prompt if given",
  details:
    "The tab opens behind this terminal unless --show, in this directory unless --cwd. With\n" +
    "--prompt its program starts at once, shown or not, and is sent the prompt as its composer\n" +
    "sends it. Its id is printed for chat wait/read/send. --model, --effort and --mode are\n" +
    "set before the prompt. A verified local chat tab can grant a mode up to its current\n" +
    "permission level. Other local increases require user approval, and unrestricted modes\n" +
    "require a grant from an unrestricted tab. --instructions-file reads the\n" +
    "new tab's session instructions from a UTF-8 file on this computer.",
  flags: {
    agent: { type: "string", value: "AGENT", description: "claude (default) or codex" },
    prompt: { type: "string", value: "TEXT", description: "The first message" },
    "instructions-file": {
      type: "string",
      value: "FILE",
      description: "Set the new tab's session instructions from FILE",
    },
    cwd: { type: "string", value: "DIR", description: "Run it in DIR (default: this directory)" },
    show: { type: "boolean", description: "Show it, beside this terminal" },
    profile: {
      type: "string",
      value: "NAME",
      description: "Run it with that agent profile (default: the workspace's)",
    },
    ...SETTING_FLAGS,
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const instructionFile = flags["instructions-file"] as string | undefined;
    if (instructionFile !== undefined && deviceFlag(flags) !== undefined) {
      throw new CliUsageError("--instructions-file goes to this computer's tabs; omit --device");
    }
    const agent = chatAgentFlag(flags.agent, "claude");
    const prompt = ((flags.prompt as string | undefined) ?? "").trim();
    const deviceSelector = deviceFlag(flags);
    const settings = settingsFlags(agent, flags, deviceSelector === undefined);
    const device = await resolveDevice(ctx, deviceSelector);
    if (device) {
      const folder = typeof flags.cwd === "string" ? flags.cwd : undefined;
      return newPeerChat(ctx, device, flags, {
        agent,
        prompt,
        ...(folder ? { folder } : {}),
        settings,
      });
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const dir = flags.cwd as string | undefined;
    const cwd =
      dir !== undefined
        ? absolutePath(ctx, workspace, dir)
        : workspace.id === ctx.caller.workspaceId
          ? ctx.invocation.cwd
          : workspace.rootPath;
    const instructions =
      instructionFile === undefined ? undefined : await readInstructionsFile(ctx, instructionFile);
    const body = [prompt, instructions].filter(Boolean).join("\n\n");
    await mayChange(ctx, workspace, {
      kind: "chatNew",
      detail: AGENT_NAMES[agent],
      ...(body ? { body } : {}),
    });
    const delegated =
      settings.mode === undefined
        ? undefined
        : await mayLoosen(
            ctx,
            workspace,
            agent,
            `"${AGENT_NAMES[agent]}"`,
            settings.mode,
            CHAT_MODES[agent].fallback,
          );
    const allowDangerousMode = delegated && settings.mode === CHAT_MODES[agent].dangerous;
    const setting = Object.keys(settings).length > 0;
    const from = prompt !== "" ? await senderOf(ctx) : undefined;
    const { tabId, error } = await ctx.services.ui(
      "chat.open",
      {
        workspaceId: workspace.id,
        agent,
        cwd,
        prompt,
        ...(instructions === undefined ? {} : { instructions }),
        ...(from ? { from } : {}),
        placement: placementFor(ctx, workspace, flags.show !== true),
        ...(setting ? { settings } : {}),
        ...(allowDangerousMode ? { allowDangerousMode } : {}),
        ...(typeof flags.profile === "string" && flags.profile.trim() !== ""
          ? { profile: flags.profile.trim() }
          : {}),
      },
      // Its program starts and lists its models before the settings go.
      setting ? SEND_TIMEOUT_MS : undefined,
    );
    const reach =
      workspace.id === ctx.caller.workspaceId ? "" : ` --workspace ${shortId(workspace.id)}`;
    if (error !== undefined) {
      const sent = prompt === "" ? "" : " The prompt was not sent.";
      return output(
        `Opened ${AGENT_NAMES[agent]} tab ${shortId(tabId)} in ${cwd}, but could not set it: ${error}.${sent}`,
        { tabId, workspaceId: workspace.id, agent, cwd, error },
        { exitCode: 1 },
      );
    }
    if (delegated) logDelegation(ctx, tabId, delegated, settings.mode);
    const text =
      prompt === ""
        ? `Opened ${AGENT_NAMES[agent]} tab ${shortId(tabId)} in ${cwd}.`
        : `Opened ${AGENT_NAMES[agent]} tab ${shortId(tabId)} in ${cwd} and sent it the prompt. To wait for it:\n` +
          `  nexus chat wait ${shortId(tabId)}${reach}`;
    return output(text, {
      tabId,
      workspaceId: workspace.id,
      agent,
      cwd,
      ...(setting ? { settings } : {}),
    });
  },
};

const chatInterrupt: CliCommand = {
  path: ["chat", "interrupt"],
  summary: "Stop the turn a Claude or Codex tab is working on",
  args: "<tab>",
  details:
    "As its stop button does: the agent stops what it runs, and the tab waits for a message.\n" +
    "Messages queued in it stay queued.",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) return interruptPeer(ctx, device, flags, selector);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    if (tab.id === ctx.caller.tabId) {
      throw new CliError("that is this tab; nexus stops only other tabs");
    }
    await mayChange(ctx, workspace, { kind: "chatInterrupt", detail: tab.title });
    const target = { workspaceId: workspace.id, tabId: tab.id };
    await ctx.services.ui("chat.interrupt", target);
    return output(`Stopped the turn of ${tab.title} (${shortId(tab.id)}).`, target);
  },
};

const chatSet: CliCommand = {
  path: ["chat", "set"],
  summary: "Set a Claude or Codex tab's model, effort, permission mode or profile, or list them",
  args: "<tab>",
  details:
    "As its composer's menus set them, for its next turn on. With no flag, prints what it runs\n" +
    "with and what it takes: the models its program lists, its model's efforts, the modes.\n" +
    "Its program must run: a tab whose program ended starts it again with a message. A\n" +
    "verified local chat tab can grant a mode up to its current permission level. Other\n" +
    "local increases require user approval, and unrestricted modes require a grant from an\n" +
    "unrestricted tab.\n" +
    "--profile runs it with another agent profile (another account or settings), as its\n" +
    "profile chip does: its conversation goes on there, or a new one starts with --new. The\n" +
    "user allows it; not while it works or asks the user.",
  flags: {
    ...SETTING_FLAGS,
    profile: { type: "string", value: "NAME", description: "Run it with that agent profile" },
    new: { type: "boolean", description: "With --profile: start a new conversation there" },
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      return setPeerChat(ctx, device, flags, selector, (agent) => settingsFlags(agent, flags));
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    const agent: ChatAgent = tab.type === "codex" ? "codex" : "claude";
    const settings = settingsFlags(agent, flags, true);
    const target = { workspaceId: workspace.id, tabId: tab.id };
    const profile = typeof flags.profile === "string" ? flags.profile.trim() : undefined;
    if (flags.new === true && profile === undefined) {
      throw new CliUsageError("--new goes with --profile");
    }
    if (profile !== undefined) {
      if (profile === "") throw new CliUsageError("--profile takes a profile's name");
      if (Object.keys(settings).length > 0) {
        throw new CliUsageError("--profile goes alone; set the model, effort or mode after it");
      }
      return setProfile(ctx, workspace, tab, profile, flags.new === true);
    }
    if (Object.keys(settings).length === 0) {
      const choices = await ctx.services.ui(
        "chat.settings",
        { ...target, settings: {} },
        SEND_TIMEOUT_MS,
      );
      return output(choicesText(tab, choices), { ...target, ...choices });
    }
    if (tab.id === ctx.caller.tabId) {
      throw new CliError("that is this tab; its settings are the user's to change");
    }
    await mayChange(ctx, workspace, { kind: "chatSettings", detail: tab.title });
    let delegated: CallerMode | undefined;
    const dangerous = settings.mode === CHAT_MODES[agent].dangerous;
    if (settings.mode !== undefined) {
      const from = dangerous
        ? undefined
        : (await ctx.services.ui("chat.settings", { ...target, settings: {} }, SEND_TIMEOUT_MS))
            .mode;
      delegated = await mayLoosen(ctx, workspace, agent, `"${tab.title}"`, settings.mode, from);
    }
    const choices = await ctx.services.ui(
      "chat.settings",
      { ...target, settings, ...(dangerous ? { allowDangerousMode: true } : {}) },
      SEND_TIMEOUT_MS,
    );
    if (delegated && choices.mode === settings.mode) {
      logDelegation(ctx, tab.id, delegated, settings.mode);
    }
    const set = [
      `model ${choices.model ?? "(its default)"}`,
      `effort ${choices.effort ?? "(the model's default)"}`,
      `mode ${choices.mode}`,
    ].join(", ");
    return output(`${tab.title} (${shortId(tab.id)}) now runs with ${set}.`, {
      ...target,
      ...choices,
    });
  },
};

/**
 * Has a tab run with another profile, the user allowing it: its
 * conversation goes on there, or a new one starts (`fresh`).
 */
async function setProfile(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  tab: CliTabInfo,
  profile: string,
  fresh: boolean,
): Promise<CliOutput> {
  if (tab.id === ctx.caller.tabId) {
    throw new CliError("that is this tab; its profile is the user's to change");
  }
  await mayChange(ctx, workspace, { kind: "chatSettings", detail: tab.title });
  const target = { workspaceId: workspace.id, tabId: tab.id };
  // Named and checked first: the user is asked about what would happen.
  const names = await ctx.services.ui("chat.profile", {
    ...target,
    profile,
    fresh,
    dryRun: true,
  });
  await ctx.services.askUser({
    fromWorkspaceId: ctx.caller.workspaceId,
    fromTabId: ctx.caller.tabId,
    toWorkspaceId: workspace.id,
    change: {
      kind: fresh ? "chatProfileNew" : "chatProfile",
      detail: `"${tab.title}" (${names.from} → ${names.to})`,
    },
  });
  const { from, to } = await ctx.services.ui(
    "chat.profile",
    { ...target, profile, fresh },
    SEND_TIMEOUT_MS,
  );
  const text = fresh
    ? `${tab.title} (${shortId(tab.id)}) now runs with the profile "${to}", in a new conversation.`
    : `${tab.title} (${shortId(tab.id)}) now runs with the profile "${to}"; its conversation goes on there.`;
  return output(text, { ...target, from, profile: to, fresh });
}

/** A tab of this computer's as chat read reads it. */
async function readChat(
  ctx: CliContext,
  flags: ParsedArgs["flags"],
  selector: string,
  messages: number | undefined,
  since: number | undefined,
): Promise<{
  tab: CliTabInfo;
  workspaceId: string;
  entries: CliChatEntry[];
  end: number;
  info: CliChatInfo;
}> {
  const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
  const tab = await resolveChat(ctx, workspace, selector);
  const { entries, end, ...info } = await ctx.services.ui("chat.read", {
    workspaceId: workspace.id,
    tabId: tab.id,
    ...(messages !== undefined ? { messages } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(flags.subagents === true ? { subagents: true } : {}),
  });
  return { tab, workspaceId: workspace.id, entries, end, info };
}

const chatRead: CliCommand = {
  path: ["chat", "read"],
  summary: "Print a Claude or Codex tab's messages, and where it stands",
  args: "<tab>",
  details:
    "What the user and the agent said, the tools the agent ran, and what the app noted, each\n" +
    "with its place (#i), then the tab's state: working, asking (the user), idle or error. The\n" +
    "last 20 by default. --since I reads on after #I, so a loop follows a tab without reading\n" +
    "anything twice; a conversation cleared or rewound since, ending before #I, is read from\n" +
    "its start and says so. A tool call's input and output whole: nexus chat tool <tab> <i>.\n" +
    "--jsonl prints a record a line: the messages (each with role and i), then the state.",
  flags: {
    messages: {
      type: "number",
      value: "N",
      description: "Only the last N (default 20, or all with --since)",
    },
    answer: {
      type: "number",
      value: "N",
      description: "Print only the answer at the displayed message number #N",
    },
    since: { type: "number", value: "I", description: "Only those after message #I" },
    all: { type: "boolean", description: "The whole conversation" },
    subagents: { type: "boolean", description: "Subagents' tool calls too" },
    "max-chars": MAX_CHARS_FLAG,
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    if (flags.answer !== undefined) {
      const index = Number(flags.answer);
      if (!Number.isSafeInteger(index) || index < 0)
        throw new CliUsageError("--answer takes the displayed # of an answer");
      if (
        flags.device !== undefined ||
        flags.since !== undefined ||
        flags.messages !== undefined ||
        flags.all === true
      )
        throw new CliUsageError(
          "--answer reads one local answer; omit --device, --since, --messages and --all",
        );
      const found = await readChat(
        ctx,
        flags,
        selector,
        undefined,
        index > 0 ? index - 1 : undefined,
      );
      const answer = found.entries.find(
        (entry) => entry.i === index && entry.role === "agent" && !entry.parentToolUseId,
      );
      if (!answer) throw new CliError(`#${index} is not an answer in that tab`);
      const text = cut(answer.text, maxCharsFlag(flags));
      return output(text, {
        workspaceId: found.workspaceId,
        tabId: found.tab.id,
        answer: { ...answer, text },
      });
    }
    const since = flags.since as number | undefined;
    if (since !== undefined && (!Number.isInteger(since) || since < 0)) {
      throw new CliUsageError("--since takes the # of a message");
    }
    if (flags.all === true && flags.messages !== undefined) {
      throw new CliUsageError("--all reads every message; leave out --messages");
    }
    const messages =
      (flags.messages as number | undefined) ??
      (flags.all === true || since !== undefined ? undefined : 20);
    if (messages !== undefined && (!Number.isInteger(messages) || messages < 1)) {
      throw new CliError("--messages takes a positive whole number", 2);
    }
    const maxChars = maxCharsFlag(flags);
    const device = await resolveDevice(ctx, deviceFlag(flags));
    const { tab, workspaceId, entries, end, info } = device
      ? await readPeerChat(ctx, device, flags, selector, {
          ...(messages !== undefined ? { messages } : {}),
          ...(since !== undefined ? { since } : {}),
          all: flags.all === true,
          subagents: flags.subagents === true,
        }).then((read) => ({
          tab: { id: read.peer.session.tabId, title: read.peer.session.title },
          workspaceId: read.peer.workspace.id,
          ...read,
        }))
      : await readChat(ctx, flags, selector, messages, since);
    const shown =
      maxChars === undefined
        ? entries
        : entries.map((entry) => ({ ...entry, text: cut(entry.text, maxChars) }));
    const transcript = chatTranscript(info, entries, maxChars);
    const about = chatAboutText(info);
    const state = `${
      info.state === "idle"
        ? `${AGENT_NAMES[info.agent]} in ${tab.title} is idle.`
        : chatStateText(tab, info)
    }${about ? `\n${about}` : ""}`;
    // Cleared or rewound since #since: the app read it from its start.
    const restarted = since !== undefined && since > end;
    const last = entries.at(-1)?.i ?? (restarted ? undefined : since);
    const stands = {
      ...infoJson(tab, workspaceId, info, device ?? undefined),
      ...(restarted ? { restarted } : {}),
    };
    const json = { ...stands, entries: shown, ...(last !== undefined ? { last } : {}) };
    const before = restarted
      ? `The conversation was cleared or rewound: it ends before #${since} now. From its start:\n`
      : since !== undefined && entries.length === 0
        ? `Nothing after #${since}.\n`
        : "";
    return output(transcript ? `${before}${transcript}\n\n${state}` : `${before}${state}`, json, {
      records: [...shown, stands],
    });
  },
};

const chatTool: CliCommand = {
  path: ["chat", "tool"],
  summary: "Print one tool call of a Claude or Codex tab whole: its input and its output",
  args: "<tab> <call>",
  details:
    "<call> is the number chat read shows by the call (#i), given alone, or the call's id: a\n" +
    "shell drops a # and what follows. The input is printed as JSON, the output as the tool\n" +
    "gave it back.",
  flags: { "max-chars": MAX_CHARS_FLAG, workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    if (positionals.length === 1) {
      // `chat tool tab #3`: the shell took "#3" for a comment.
      throw new CliUsageError(
        "missing <call>: the number chat read shows by it, without its # (a shell drops a # and what follows)",
      );
    }
    const [selector, refArg] = exactArgs(positionals, "tab", "call") as [string, string];
    const maxChars = maxCharsFlag(flags);
    const ref = refArg.replace(/^#/, "");
    const device = await resolveDevice(ctx, deviceFlag(flags));
    const found = device
      ? await peerChatTool(ctx, device, flags, selector, ref)
      : await (async () => {
          const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
          const tab = await resolveChat(ctx, workspace, selector);
          const target = { workspaceId: workspace.id, tabId: tab.id };
          return { ref: target, tool: await ctx.services.ui("chat.tool", { ...target, ref }) };
        })();
    const tool = found.tool;
    const input = typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 2);
    const lines = [
      `#${tool.i} ${tool.name} (${tool.status})${tool.parentToolUseId ? " (subagent)" : ""}  ${tool.toolUseId}`,
      "── input",
      cut(input ?? "", maxChars),
      tool.result
        ? `── output${tool.result.isError ? " (error)" : ""}\n${cut(tool.result.text, maxChars)}`
        : "── no output yet",
    ];
    const json =
      maxChars === undefined || !tool.result
        ? tool
        : { ...tool, result: { ...tool.result, text: cut(tool.result.text, maxChars) } };
    return output(lines.join("\n"), { ...json, ...found.ref });
  },
};

/** The files --file names, read where the caller runs, for a tab to take. */
async function attachments(
  ctx: CliContext,
  given: readonly string[],
): Promise<{ name: string; data: string }[]> {
  return Promise.all(
    given.map(async (file) => {
      const where = callerPath(ctx, file);
      const data = await ctx.services.readFile(ctx.caller.workspaceId, where);
      if (data === null) throw new CliError(`no file ${where}`);
      return { name: path.basename(where), data };
    }),
  );
}

/** A --file flag's paths: none, one, or more. */
function filesFlag(flags: ParsedArgs["flags"]): string[] {
  const given = flags.file;
  if (given === undefined) return [];
  const files = (Array.isArray(given) ? given : [String(given)]).filter((f) => f.trim() !== "");
  if (files.length === 0) throw new CliUsageError("--file takes a path");
  return files;
}

async function imageAttachment(ctx: CliContext, file: string) {
  const [image] = await attachments(ctx, [file]);
  if (!image) throw new CliUsageError("--image takes a path");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > MAX_ATTACHMENT_BYTES)
    throw new CliUsageError(`the image exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
  const mediaType = ImageMediaTypeSchema.options.find((type) => looksLike(type, bytes));
  if (!mediaType) throw new CliUsageError("--image needs a PNG, JPEG, GIF or WebP image");
  return { mediaType, data: image.data };
}

const chatSend: CliCommand = {
  path: ["chat", "send"],
  summary: "Send a Claude or Codex tab a message",
  args: "<tab> [text...]",
  details:
    "As its composer sends it: during a turn, the agent reads it after the tool it runs. --now\n" +
    "puts it into the turn at once. With no text, --now has a Claude tab read its unread\n" +
    "messages. --after holds it until the turn ends. For held messages, use the printed id\n" +
    'with chat unsend and chat edit. "-" reads the text from standard input. --file attaches a\n' +
    "file of this computer (this terminal's), written where the tab's agent reads it, its\n" +
    "path after the text. Refused while the tab waits for the user to answer a request.\n" +
    "--wait then waits as chat wait does and prints how it ended. Another computer's tab\n" +
    "(--device) also accepts --now and --after. Held peer messages are dropped when its user disables control by agents.",
  flags: {
    now: { type: "boolean", description: "During a turn: into it at once" },
    after: { type: "boolean", description: "During a turn: held until it ends" },
    file: {
      type: "string",
      value: "PATH",
      repeat: true,
      description: "Attach a file; give it again for more",
    },
    image: { type: "string", value: "PATH", description: "Attach a PNG, JPEG, GIF or WebP image" },
    wait: { type: "boolean", description: "Then wait until it is done" },
    timeout: TIMEOUT_FLAG,
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, ...words] = positionals;
    if (selector === undefined) throw new CliUsageError("missing <tab>");
    if (flags.now === true && flags.after === true) {
      throw new CliUsageError("--now or --after, not both");
    }
    const when = flags.now === true ? "now" : flags.after === true ? "after" : undefined;
    const fromStdin = words.length === 1 && words[0] === "-";
    const text = (
      fromStdin ? (ctx.invocation.stdin ?? "").replace(/\r?\n$/, "") : words.join(" ")
    ).trim();
    const files = filesFlag(flags);
    const imagePath = typeof flags.image === "string" ? flags.image : undefined;
    // ⌘↩ on an empty composer: the messages sent during the turn are read now.
    const hurry =
      when === "now" && words.length === 0 && files.length === 0 && imagePath === undefined;
    if (text === "" && files.length === 0 && imagePath === undefined && !hurry)
      throw new CliUsageError("nothing to send");
    const timeoutMs = flags.wait === true ? waitTimeout(flags) : null;
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      if (files.length > 0) throw new CliUsageError("--file goes to this computer's tabs");
      if (hurry) throw new CliUsageError("--now with no text goes to this computer's tabs");
      if (when === "after" || imagePath !== undefined) requirePeerCli(ctx, device);
      const images = imagePath === undefined ? [] : [await imageAttachment(ctx, imagePath)];
      return sendToPeer(ctx, device, flags, selector, text, timeoutMs, when, images);
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    if (tab.id === ctx.caller.tabId) {
      throw new CliError("that is this tab; nexus sends only to other tabs");
    }
    const target = { workspaceId: workspace.id, tabId: tab.id };
    if (hurry) {
      if (tab.type !== "claude") throw new CliError("only a Claude tab reads its messages at once");
      await mayChange(ctx, workspace, { kind: "chatInput", detail: tab.title });
      await ctx.services.ui("chat.hurry", target);
      return output(`Had ${tab.title} (${shortId(tab.id)}) read its messages now.`, target);
    }
    const attached = await attachments(ctx, files);
    const images = imagePath === undefined ? [] : [await imageAttachment(ctx, imagePath)];
    const listed = attached.map((file) => `[${file.name}]`).join(" ");
    await mayChange(ctx, workspace, {
      kind: "chatInput",
      detail: tab.title,
      body: [text, listed, imagePath === undefined ? "" : `[image: ${path.basename(imagePath)}]`]
        .filter(Boolean)
        .join("\n\n"),
    });
    // An agent's message shows as its, and the tab's agent is told who sent
    // it, and whether it waits to read the answer there or is to be written back to.
    const sender = await senderOf(ctx);
    const from = sender ? { ...sender, waits: timeoutMs !== null } : undefined;
    // Starting a program that is gone comes before the message.
    const { heldId, submissionId } = await ctx.services.ui(
      "chat.send",
      {
        ...target,
        text,
        ...(from ? { from } : {}),
        ...(attached.length > 0 ? { files: attached } : {}),
        ...(images.length ? { images } : {}),
        ...(when ? { when } : {}),
        ...(timeoutMs === null ? {} : { wait: {} }),
      },
      SEND_TIMEOUT_MS,
    );
    const named = `${tab.title} (${shortId(tab.id)})`;
    const sent = heldId
      ? `Held ${when === "after" ? "for after the turn of" : "by"} ${named}, as ${heldId}.`
      : `Sent to ${named}.`;
    const json = {
      ...target,
      text,
      ...(attached.length > 0 ? { files: attached.map((file) => file.name) } : {}),
      ...(heldId ? { heldId } : {}),
    };
    if (timeoutMs === null) return output(sent, json);
    const result = await waitOnChat(ctx, workspace, tab, timeoutMs, submissionId);
    return waitOutput(`${sent}\n${result.text}`, json, result);
  },
};

/** How long chat send gives a tab to start its program and take the message. */
export const SEND_TIMEOUT_MS = 60_000;

const chatWait: CliCommand = {
  path: ["chat", "wait"],
  summary: "Wait until a Claude or Codex tab is done, and print its answer",
  args: "<tab...>",
  details:
    "Done means: the turn ended (its last answer is printed), the agent is waiting for the user\n" +
    "to allow a tool or answer a question, or it stopped on an error. A message sent it that it\n" +
    "has not taken yet counts as work. Given several tabs, it waits for the first of them to be\n" +
    'done; to follow tabs across workspaces, see "nexus events". When the wait runs out, nexus\n' +
    "exits with 124; run it again to wait longer.",
  flags: { timeout: TIMEOUT_FLAG, workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    if (positionals.length === 0) throw new CliUsageError("missing <tab>");
    const timeoutMs = waitTimeout(flags);
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) return waitOnPeer(ctx, device, flags, positionals, timeoutMs);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tabs: CliTabInfo[] = [];
    for (const selector of positionals) {
      const tab = await resolveChat(ctx, workspace, selector);
      if (tab.id === ctx.caller.tabId) {
        throw new CliError("that is this tab; it cannot wait on itself");
      }
      if (!tabs.some((t) => t.id === tab.id)) tabs.push(tab);
    }
    const result = await waitOnChats(ctx, workspace, tabs, timeoutMs);
    const which = result.tab ?? (tabs.length === 1 ? tabs[0] : undefined);
    return waitOutput(
      result.text,
      { ...(which ? { tabId: which.id } : {}), workspaceId: workspace.id },
      result,
    );
  },
};

/** How chat.state tells a tool's permission request (renderer services/cli/chat-view). */
const ASKS_TO_RUN = "asks to run ";

/** The tools whose requests are a question or a plan for the user, not a tool to allow. */
const USERS_TO_ANSWER = new Set(["AskUserQuestion", "ExitPlanMode"]);

async function unrestrictedCaller(ctx: CliContext): Promise<CallerMode | undefined> {
  const caller = await verifiedChatMode(ctx);
  if (caller?.mode && caller.mode === CHAT_MODES[caller.agent].dangerous) return caller;
}

/** Authorizes one answer to the request as it was asked. */
async function mayAnswer(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  change: ChangeRequest["change"],
): Promise<CallerMode | undefined> {
  let caller = await unrestrictedCaller(ctx);
  if (caller && workspace.id !== ctx.caller.workspaceId) {
    await mayChange(ctx, workspace, change);
    // The workspace policy can wait for a user decision. Read the mode again.
    caller = await unrestrictedCaller(ctx);
  }
  if (caller) return caller;
  await ctx.services.askUser({
    fromWorkspaceId: ctx.caller.workspaceId,
    fromTabId: ctx.caller.tabId,
    toWorkspaceId: workspace.id,
    change,
  });
}

/**
 * The tab chat answer answers in: a Claude or Codex tab, or else a
 * terminal whose Claude Code asks (a chat tab is named first).
 */
async function answeringTab(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  selector: string,
): Promise<CliTabInfo> {
  const tabs = await workspaceTabs(ctx, workspace.id);
  try {
    return resolveTab(
      ctx,
      tabs.filter(isChatTab),
      selector,
      `Claude or Codex tab in ${workspace.name}`,
    );
  } catch (error) {
    const terminals = tabs.filter((tab) => tab.type === "terminal");
    try {
      return resolveTab(ctx, terminals, selector, `terminal in ${workspace.name}`);
    } catch {
      throw error;
    }
  }
}

/** chat answer for a terminal: the request its Claude Code holds, as the app's card answers it. */
async function answerTerminal(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  tab: CliTabInfo,
  decision: "allow" | "deny",
  message: string | undefined,
  stop: boolean,
): Promise<CliOutput> {
  if (message !== undefined) {
    throw new CliUsageError("--message goes to a Claude or Codex tab, not a terminal");
  }
  const [ask] = [...ctx.services.claudeAsks(workspace.id, tab.id)].sort(
    (a, b) => a.since - b.since,
  );
  if (!ask) throw new CliError(`${tab.title} waits on no permission request`);
  if (USERS_TO_ANSWER.has(ask.tool)) {
    throw new CliError(`${tab.title} asks the user; that is the user's to answer in the app`);
  }
  const what = [ask.tool, ask.target].filter(Boolean).join(" ");
  const delegated = await mayAnswer(ctx, workspace, {
    kind: decision === "allow" ? "permissionAllow" : "permissionDeny",
    detail: `${ask.tool} (${tab.title})`,
    body: what,
  });
  const answer = decision === "allow" ? "allow" : stop ? "denyStop" : "deny";
  if (!(await ctx.services.answerClaudeAsk(workspace.id, tab.id, ask.id, answer))) {
    throw new CliError(
      answer === "denyStop"
        ? "a subagent's request cannot stop the turn"
        : "that request no longer waits for an answer",
    );
  }
  if (delegated) logDelegation(ctx, tab.id, delegated);
  const target = { workspaceId: workspace.id, tabId: tab.id };
  return output(`${decision === "allow" ? "Allowed" : "Denied"} ${what} in ${tab.title}.`, {
    ...target,
    decision,
    tool: ask.tool,
  });
}

const chatAnswer: CliCommand = {
  path: ["chat", "answer"],
  summary: "Allow or deny the tool a Claude or Codex tab, or a terminal's Claude Code, asks to run",
  args: "<tab> <allow|deny>",
  details:
    "Answers the permission request the tab waits on, as the user would in it; --message tells\n" +
    "the agent why with a deny, --stop stops its turn too. A terminal's Claude Code is answered\n" +
    "as the app's card answers it. A question or a plan the agent puts to the user is theirs\n" +
    "to answer in the app. A verified local chat tab in an unrestricted mode can approve\n" +
    "or deny a tool as requested, once. Other local callers need the user's approval.\n" +
    "On another device, the receiving device's Remote agent policy applies.",
  flags: {
    message: { type: "string", value: "TEXT", description: "With deny: what to tell the agent" },
    stop: { type: "boolean", description: "With deny: stop the turn too" },
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, decision] = exactArgs(positionals, "tab", "answer") as [string, string];
    if (decision !== "allow" && decision !== "deny") {
      throw new CliUsageError('the answer is "allow" or "deny"');
    }
    const message = (flags.message as string | undefined)?.trim();
    if (message !== undefined && decision !== "deny") {
      throw new CliUsageError("--message goes with deny");
    }
    const stop = flags.stop === true;
    if (stop && decision !== "deny") throw new CliUsageError("--stop goes with deny");
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      if (stop) throw new CliUsageError("--stop goes to this computer's tabs");
      return answerPeer(ctx, device, flags, selector, decision, message);
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await answeringTab(ctx, workspace, selector);
    if (tab.id === ctx.caller.tabId) {
      throw new CliError("that is this tab; its requests are the user's to answer");
    }
    if (tab.type === "terminal") {
      return answerTerminal(ctx, workspace, tab, decision, message, stop);
    }
    const target = { workspaceId: workspace.id, tabId: tab.id };
    const info = await ctx.services.ui("chat.state", target);
    const asked = info.state === "asking" ? (info.message ?? "") : "";
    if (!asked.startsWith(ASKS_TO_RUN) || !info.request || USERS_TO_ANSWER.has(info.request.tool)) {
      throw new CliError(
        asked === ""
          ? `${tab.title} waits on no permission request`
          : `${tab.title} ${asked}; that is the user's to answer in the app`,
      );
    }
    const tool = asked.slice(ASKS_TO_RUN.length);
    // What is answered is the request whole: a command's first line, as the
    // tab's row shows it, can hide what its next lines run.
    // The CLI only allows this answer once and sends the request's original input.
    const delegated = await mayAnswer(ctx, workspace, {
      kind: decision === "allow" ? "permissionAllow" : "permissionDeny",
      detail: `${info.request.tool} (${tab.title})`,
      body: info.request.input,
    });
    await ctx.services.ui("chat.answer", {
      ...target,
      decision,
      ...(message ? { message } : {}),
      ...(stop ? { stop } : {}),
      expect: info.request.id,
    });
    if (delegated) logDelegation(ctx, tab.id, delegated);
    return output(`${decision === "allow" ? "Allowed" : "Denied"} ${tool} in ${tab.title}.`, {
      ...target,
      decision,
      tool,
    });
  },
};

const chatInstructions: CliCommand = {
  path: ["chat", "instructions"],
  summary: "View or edit a chat tab's instructions",
  args: "<tab>",
  details:
    "Use exactly one of --show, --set-file FILE, or --clear. Edits apply from the next message. Other devices support --show.",
  flags: {
    show: { type: "boolean", description: "Print the combined instructions for the tab" },
    "set-file": {
      type: "string",
      value: "FILE",
      description: "Replace the session layer with UTF-8 text from FILE",
    },
    clear: { type: "boolean", description: "Clear the session layer" },
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const show = flags.show === true;
    const file = flags["set-file"] as string | undefined;
    const clear = flags.clear === true;
    if ([show, file !== undefined, clear].filter(Boolean).length !== 1) {
      throw new CliUsageError("use exactly one of --show, --set-file FILE, or --clear");
    }
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      const target = await peerCliChat(ctx, device, flags, selector);
      const { instructions } = show
        ? await askPeerCli(ctx, device, "chat.instructions", target.ref)
        : await changePeerCli(ctx, device, "chat.instructions.set", {
            ...target.ref,
            text: file === undefined ? "" : await readInstructionsFile(ctx, file),
          });
      return output(show ? instructions : `Updated session instructions for ${target.title}.`, {
        ...target.json,
        instructions,
      });
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    const target = { workspaceId: workspace.id, tabId: tab.id };
    const text = file === undefined ? "" : await readInstructionsFile(ctx, file);
    if (!show) {
      await mayChange(ctx, workspace, {
        kind: "chatSettings",
        detail: tab.title,
        ...(text ? { body: text } : {}),
      });
    }
    const { instructions } = await ctx.services.ui(
      "chat.instructions",
      show ? target : { ...target, text },
    );
    return output(
      show ? instructions : `Updated session instructions for ${tab.title} (${shortId(tab.id)}).`,
      {
        ...target,
        instructions,
      },
    );
  },
};

const chatImage: CliCommand = {
  path: ["chat", "image"],
  args: "<tab> [index]",
  summary: "Read an image from a chat message, tool result, or held message",
  details:
    "Image indexes count from 1. Output is base64 by default. --out creates a new file on the app's machine.",
  flags: {
    message: {
      type: "number",
      value: "N",
      description: "The user message number shown by chat read",
    },
    tool: { type: "string", value: "ID", description: "A tool call's id" },
    held: { type: "string", value: "ID", description: "A held message's id" },
    out: { type: "string", value: "FILE", description: "Write image bytes to a new file" },
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals: [selector, given = "1", ...extra], flags }) {
    const index = Number(given) - 1;
    if (!selector || extra.length || !Number.isInteger(index) || index < 0)
      throw new CliUsageError("give a tab and a positive image index");
    const message = typeof flags.message === "number" ? flags.message : undefined;
    const tool = typeof flags.tool === "string" ? flags.tool : undefined;
    const held = typeof flags.held === "string" ? flags.held : undefined;
    if ([message, tool, held].filter((value) => value !== undefined).length !== 1)
      throw new CliUsageError("give one of --message N, --tool ID, or --held ID");
    if (message !== undefined && (!Number.isInteger(message) || message < 0))
      throw new CliUsageError("--message takes the displayed message number");
    if (flags.out !== undefined && !onAppMachine(ctx))
      throw new CliUsageError("--out needs a shell on the app's machine; omit it to read base64");
    const device = await resolveDevice(ctx, deviceFlag(flags));
    const target = device
      ? (await peerCliChat(ctx, device, flags, selector)).ref
      : await localChatRef(ctx, flags, selector);
    let ref: RpcParams<"chat.image">["ref"];
    if (message !== undefined) {
      const request = { ...target, i: message };
      const item = device
        ? await askPeerCli(ctx, device, "chat.entryItem", request)
        : await ctx.services.ui("chat.entryItem", request);
      if (item.kind !== "user") throw new CliError("that is not a user message");
      ref = { kind: "user", itemKey: item.itemKey, index };
    } else if (tool !== undefined) {
      ref = { kind: "tool", toolUseId: tool, index };
    } else {
      ref = { kind: "held", id: held as string, index };
    }
    const image = device
      ? await askPeerCli(ctx, device, "chat.image", { ...target, ref })
      : await ctx.services.ui("chat.image", { ...target, ref, maxChars: MAX_MESSAGE_BYTES - 1024 });
    if (!image.data) throw new CliError("there are no image bytes for that entry");
    const { data, ...metadata } = image;
    const out = typeof flags.out === "string" ? callerPath(ctx, flags.out) : undefined;
    if (out) {
      await writeFile(out, Buffer.from(data, "base64"), { flag: "wx" });
      return output(`Wrote ${out}.`, { ...metadata, path: out });
    }
    return output(data, { ...metadata, data });
  },
};

async function localChatRef(ctx: CliContext, flags: ParsedArgs["flags"], selector: string) {
  const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
  const tab = await resolveChat(ctx, workspace, selector);
  return { workspaceId: workspace.id, tabId: tab.id };
}

const chatExport: CliCommand = {
  path: ["chat", "export"],
  args: "<tab>",
  summary: "Print the conversation as Markdown",
  flags: {
    stdout: { type: "boolean", description: "Write the Markdown to standard output" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    const { markdown } = await ctx.services.ui("chat.export", ref);
    return output(markdown, { ...ref, markdown });
  },
};

export const chatCommands: CliCommand[] = [
  chatNew,
  chatInstructions,
  chatRead,
  chatExport,
  chatImage,
  chatTool,
  chatSend,
  chatAnswer,
  chatInterrupt,
  chatSet,
  chatWait,
];

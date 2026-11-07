/**
 * nexus chat ...: the app's Claude and Codex tabs, driven as their composer
 * drives them. A tab's conversation is the renderer's; these ask it, read it
 * whole or a piece at a time, and wait on one or several tabs.
 */
import type { CliChatEntry, CliChatInfo, CliTabInfo } from "../../../../shared/cli/ui";
import { isManager } from "../../../../shared/manager/manager";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { CliUsageError, exactArgs, type ParsedArgs, parseDuration } from "../args";
import {
  type CliContext,
  CliError,
  mayChange,
  noteDispatch,
  placementFor,
  resolveTab,
  resolveWorkspace,
  shortId,
} from "../context";
import { oneLine } from "../format";
import { absolutePath } from "../paths";
import { type CliCommand, type CliOutput, output } from "../registry";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, WAIT_POLL_MS, type WaitResult } from "../wait";
import { WORKSPACE_FLAG } from "./flags";
import { workspaceTabs } from "./terminal";

const AGENT_NAMES: Readonly<Record<ChatAgent, string>> = { claude: "Claude", codex: "Codex" };

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

/** How a tab stands, in a sentence. */
export function chatStateText(tab: CliTabInfo, info: CliChatInfo): string {
  const who = `${AGENT_NAMES[info.agent]} in ${tab.title}`;
  const said = info.message ? oneLine(info.message, 500) : "";
  switch (info.state) {
    case "working":
      return `${who} is working.`;
    case "asking":
      return said
        ? `${who} is waiting for the user: it ${said}.`
        : `${who} is waiting for the user.`;
    case "error":
      return `${who} stopped on an error${said ? `: ${said}` : "."}`;
    case "idle":
      return info.message ? `${who} finished:\n${info.message}` : `${who} is idle.`;
  }
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
      return entry.role === "tool" || entry.role === "notice"
        ? `[${label} #${entry.i}]${sub} ${cut(entry.text, maxChars)}`
        : `── ${label} #${entry.i}\n${cut(entry.text, maxChars)}`;
    })
    .join("\n");
}

function infoJson(tab: CliTabInfo, workspace: WorkspaceMeta, info: CliChatInfo) {
  return {
    tabId: tab.id,
    workspaceId: workspace.id,
    title: tab.title,
    agent: info.agent,
    state: info.state,
    ...(info.message ? { message: info.message } : {}),
    ...(info.since !== undefined ? { since: info.since } : {}),
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
      if (clock.now() - startedAt >= timeoutMs) {
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
): Promise<WaitResult> {
  return waitOnChats(ctx, workspace, [tab], timeoutMs);
}

/** A wait's result as the command prints it; exit 124 when the wait ran out. */
function waitOutput(text: string, json: Record<string, unknown>, result: WaitResult): CliOutput {
  return output(
    text,
    { ...json, state: result.state, ...(result.message ? { message: result.message } : {}) },
    result.done ? {} : { exitCode: 124 },
  );
}

const chatNew: CliCommand = {
  path: ["chat", "new"],
  summary: "Open a Claude or Codex tab, sending it a prompt if given",
  details:
    "The tab opens behind this terminal unless --show, in this directory unless --cwd. With\n" +
    "--prompt its program starts at once, shown or not, and is sent the prompt as its composer\n" +
    "sends it. Its id is printed for chat wait/read/send.",
  flags: {
    agent: { type: "string", value: "AGENT", description: "claude (default) or codex" },
    prompt: { type: "string", value: "TEXT", description: "The first message" },
    cwd: { type: "string", value: "DIR", description: "Run it in DIR (default: this directory)" },
    show: { type: "boolean", description: "Show it, beside this terminal" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const agent = chatAgentFlag(flags.agent, "claude");
    const prompt = ((flags.prompt as string | undefined) ?? "").trim();
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const dir = flags.cwd as string | undefined;
    const cwd =
      dir !== undefined
        ? absolutePath(ctx, workspace, dir)
        : workspace.id === ctx.caller.workspaceId
          ? ctx.invocation.cwd
          : workspace.rootPath;
    await mayChange(ctx, workspace, { kind: "chatNew", detail: AGENT_NAMES[agent] });
    const { tabId } = await ctx.services.ui("chat.open", {
      workspaceId: workspace.id,
      agent,
      cwd,
      prompt,
      placement: placementFor(ctx, workspace, flags.show !== true),
    });
    if (prompt !== "") await noteDispatch(ctx, { workspaceId: workspace.id, tabId }, prompt);
    const reach =
      workspace.id === ctx.caller.workspaceId ? "" : ` --workspace ${shortId(workspace.id)}`;
    const text =
      prompt === ""
        ? `Opened ${AGENT_NAMES[agent]} tab ${shortId(tabId)} in ${cwd}.`
        : `Opened ${AGENT_NAMES[agent]} tab ${shortId(tabId)} in ${cwd} and sent it the prompt. To wait for it:\n` +
          `  nexus chat wait ${shortId(tabId)}${reach}`;
    return output(text, { tabId, workspaceId: workspace.id, agent, cwd });
  },
};

const chatRead: CliCommand = {
  path: ["chat", "read"],
  summary: "Print a Claude or Codex tab's messages, and where it stands",
  args: "<tab>",
  details:
    "What the user and the agent said, the tools the agent ran, and what the app noted, each\n" +
    "with its place (#i), then the tab's state: working, asking (the user), idle or error. The\n" +
    "last 20 by default. --since I reads on after #I, so a loop follows a tab without reading\n" +
    "anything twice. A tool call's input and output whole: nexus chat tool <tab> <i>.\n" +
    "--jsonl prints a record a line: the messages (each with role and i), then the state.",
  flags: {
    messages: {
      type: "number",
      value: "N",
      description: "Only the last N (default 20, or all with --since)",
    },
    since: { type: "number", value: "I", description: "Only those after message #I" },
    all: { type: "boolean", description: "The whole conversation" },
    subagents: { type: "boolean", description: "Subagents' tool calls too" },
    "max-chars": MAX_CHARS_FLAG,
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
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
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    const { entries, ...info } = await ctx.services.ui("chat.read", {
      workspaceId: workspace.id,
      tabId: tab.id,
      ...(messages !== undefined ? { messages } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(flags.subagents === true ? { subagents: true } : {}),
    });
    const shown =
      maxChars === undefined
        ? entries
        : entries.map((entry) => ({ ...entry, text: cut(entry.text, maxChars) }));
    const transcript = chatTranscript(info, entries, maxChars);
    const state =
      info.state === "idle"
        ? `${AGENT_NAMES[info.agent]} in ${tab.title} is idle.`
        : chatStateText(tab, info);
    const last = entries.at(-1)?.i ?? since;
    const json = {
      ...infoJson(tab, workspace, info),
      entries: shown,
      ...(last !== undefined ? { last } : {}),
    };
    const nothingNew =
      since !== undefined && entries.length === 0 ? `Nothing after #${since}.\n` : "";
    return output(transcript ? `${transcript}\n\n${state}` : `${nothingNew}${state}`, json, {
      records: [...shown, infoJson(tab, workspace, info)],
    });
  },
};

const chatTool: CliCommand = {
  path: ["chat", "tool"],
  summary: "Print one tool call of a Claude or Codex tab whole: its input and its output",
  args: "<tab> <call>",
  details:
    "<call> is the #i chat read shows by the call, or the call's id. The input is printed as\n" +
    "JSON, the output as the tool gave it back.",
  flags: { "max-chars": MAX_CHARS_FLAG, workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, ref] = exactArgs(positionals, "tab", "call") as [string, string];
    const maxChars = maxCharsFlag(flags);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    const tool = await ctx.services.ui("chat.tool", {
      workspaceId: workspace.id,
      tabId: tab.id,
      ref: ref.replace(/^#/, ""),
    });
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
    return output(lines.join("\n"), { ...json, tabId: tab.id, workspaceId: workspace.id });
  },
};

const chatSend: CliCommand = {
  path: ["chat", "send"],
  summary: "Send a Claude or Codex tab a message",
  args: "<tab> <text...>",
  details:
    'As its composer sends it: during a turn, the agent reads it after the tool it runs. "-"\n' +
    "reads the text from standard input. Refused while the tab waits for the user to answer a\n" +
    "request. --wait then waits as chat wait does and prints how it ended.",
  flags: {
    wait: { type: "boolean", description: "Then wait until it is done" },
    timeout: TIMEOUT_FLAG,
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, ...words] = positionals;
    if (selector === undefined) throw new CliUsageError("missing <tab>");
    const fromStdin = words.length === 1 && words[0] === "-";
    const text = (
      fromStdin ? (ctx.invocation.stdin ?? "").replace(/\r?\n$/, "") : words.join(" ")
    ).trim();
    if (text === "") throw new CliUsageError("nothing to send");
    const timeoutMs = flags.wait === true ? waitTimeout(flags) : null;
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    if (tab.id === ctx.caller.tabId) {
      throw new CliError("that is this tab; nexus sends only to other tabs");
    }
    await mayChange(ctx, workspace, { kind: "chatInput", detail: tab.title });
    // Starting a program that is gone comes before the message.
    await ctx.services.ui(
      "chat.send",
      { workspaceId: workspace.id, tabId: tab.id, text },
      SEND_TIMEOUT_MS,
    );
    await noteDispatch(ctx, { workspaceId: workspace.id, tabId: tab.id }, text);
    const sent = `Sent to ${tab.title} (${shortId(tab.id)}).`;
    const json = { tabId: tab.id, workspaceId: workspace.id, text };
    if (timeoutMs === null) return output(sent, json);
    const result = await waitOnChat(ctx, workspace, tab, timeoutMs);
    return waitOutput(`${sent}\n${result.text}`, json, result);
  },
};

/** How long chat send gives a tab to start its program and take the message. */
const SEND_TIMEOUT_MS = 60_000;

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
  flags: { timeout: TIMEOUT_FLAG, workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    if (positionals.length === 0) throw new CliUsageError("missing <tab>");
    const timeoutMs = waitTimeout(flags);
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

const chatAnswer: CliCommand = {
  path: ["chat", "answer"],
  summary: "Allow or deny the tool a Claude or Codex tab asks to run",
  args: "<tab> <allow|deny>",
  details:
    "Answers the permission request the tab waits on, as the user would in it; --message tells\n" +
    "the agent why with a deny. A question or a plan the agent puts to the user is theirs to\n" +
    "answer in the app. The agent manager answers as Settings › Agent manager lets it; anyone\n" +
    "else, with the user's leave, asked each time.",
  flags: {
    message: { type: "string", value: "TEXT", description: "With deny: what to tell the agent" },
    workspace: WORKSPACE_FLAG,
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
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    if (tab.id === ctx.caller.tabId) {
      throw new CliError("that is this tab; its requests are the user's to answer");
    }
    const target = { workspaceId: workspace.id, tabId: tab.id };
    const info = await ctx.services.ui("chat.state", target);
    const asked = info.state === "asking" ? (info.message ?? "") : "";
    if (!asked.startsWith(ASKS_TO_RUN)) {
      throw new CliError(
        asked === ""
          ? `${tab.title} waits on no permission request`
          : `${tab.title} ${asked}; that is the user's to answer in the app`,
      );
    }
    const tool = asked.slice(ASKS_TO_RUN.length);
    const request = {
      fromWorkspaceId: ctx.caller.workspaceId,
      fromTabId: ctx.caller.tabId,
      toWorkspaceId: workspace.id,
      change: {
        kind: decision === "allow" ? ("permissionAllow" as const) : ("permissionDeny" as const),
        detail: `${tool} (${tab.title})`,
      },
    };
    const policy = isManager(ctx.caller) ? ctx.services.managerPermissions() : "ask";
    if (policy === "user") {
      throw new CliError(
        `the user answers other sessions' permission requests (Settings › Agent manager); tell them ${tab.title} asks to run ${tool}`,
      );
    }
    if (policy === "ask") await ctx.services.askUser(request);
    await ctx.services.ui("chat.answer", {
      ...target,
      decision,
      ...(message ? { message } : {}),
      expect: asked,
    });
    return output(`${decision === "allow" ? "Allowed" : "Denied"} ${tool} in ${tab.title}.`, {
      ...target,
      decision,
      tool,
    });
  },
};

export const chatCommands: CliCommand[] = [
  chatNew,
  chatRead,
  chatTool,
  chatSend,
  chatAnswer,
  chatWait,
];

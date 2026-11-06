/**
 * nexus chat ...: the app's Claude and Codex tabs, driven as their composer
 * drives them. A tab's conversation is the renderer's; these ask it.
 */
import type { CliChatEntry, CliChatInfo, CliTabInfo } from "../../../../shared/cli/ui";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { CliUsageError, exactArgs, type ParsedArgs, parseDuration } from "../args";
import {
  type CliContext,
  CliError,
  mayChange,
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

/** A conversation as chat read prints it: each message under who said it. */
export function chatTranscript(info: CliChatInfo, entries: readonly CliChatEntry[]): string {
  return entries
    .map((entry) => {
      const label = entry.role === "agent" ? info.agent : ROLE_LABELS[entry.role];
      return entry.role === "tool" || entry.role === "notice"
        ? `[${label}] ${entry.text}`
        : `── ${label}\n${entry.text}`;
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
  };
}

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
 * Waits until a Claude or Codex tab is done working: idle after its turn,
 * asking the user, or stopped on an error. Never throws for a timeout.
 */
export async function waitOnChat(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  tab: CliTabInfo,
  timeoutMs: number,
): Promise<WaitResult> {
  const { clock } = ctx.services;
  const startedAt = clock.now();
  const end = ctx.services.waits.begin(
    ctx.caller,
    { workspaceId: workspace.id, tabId: tab.id },
    startedAt,
  );
  try {
    for (;;) {
      const tabs = await workspaceTabs(ctx, workspace.id);
      if (!tabs.some((t) => t.id === tab.id)) {
        return { done: true, state: "closed", text: `${tab.title} was closed.` };
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
        };
      }
      if (clock.now() - startedAt >= timeoutMs) {
        return {
          done: false,
          state: "timeout",
          text: `${tab.title} was still working when the wait ran out; see it with "nexus chat read".`,
        };
      }
      await clock.sleep(WAIT_POLL_MS);
    }
  } finally {
    end();
  }
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
  summary: "Print a Claude or Codex tab's last messages, and where it stands",
  args: "<tab>",
  details:
    "What the user and the agent said, the tools the agent ran, and what the app noted, then\n" +
    "the tab's state: working, asking (the user), idle or error.",
  flags: {
    messages: {
      type: "number",
      value: "N",
      description: "How many of the last messages (default 20)",
    },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const messages = (flags.messages as number | undefined) ?? 20;
    if (!Number.isInteger(messages) || messages < 1) {
      throw new CliError("--messages takes a positive whole number", 2);
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    const { entries, ...info } = await ctx.services.ui("chat.read", {
      workspaceId: workspace.id,
      tabId: tab.id,
      messages,
    });
    const transcript = chatTranscript(info, entries);
    const state =
      info.state === "idle"
        ? `${AGENT_NAMES[info.agent]} in ${tab.title} is idle.`
        : chatStateText(tab, info);
    return output(transcript ? `${transcript}\n\n${state}` : state, {
      ...infoJson(tab, workspace, info),
      entries,
    });
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
  args: "<tab>",
  details:
    "Done means: the turn ended (its last answer is printed), the agent is waiting for the user\n" +
    "to allow a tool or answer a question, or it stopped on an error. A message sent it that it\n" +
    "has not taken yet counts as work. When the wait runs out, nexus exits with 124.",
  flags: { timeout: TIMEOUT_FLAG, workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const timeoutMs = waitTimeout(flags);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveChat(ctx, workspace, selector);
    if (tab.id === ctx.caller.tabId) {
      throw new CliError("that is this tab; it cannot wait on itself");
    }
    const result = await waitOnChat(ctx, workspace, tab, timeoutMs);
    return waitOutput(result.text, { tabId: tab.id, workspaceId: workspace.id }, result);
  },
};

export const chatCommands: CliCommand[] = [chatNew, chatRead, chatSend, chatWait];

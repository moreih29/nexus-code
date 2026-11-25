import type { ChatCommand, ChatPanel } from "../../../../../packages/remote-protocol/src";
import type { CliPastSession, CliTabInfo } from "../../../../shared/cli/ui";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { shortId } from "../../../../shared/util/short-id";
import {
  applyRemoteControl,
  remoteControlCommand,
  remoteControlOutput,
} from "../../chat/remote-control";
import { CliUsageError, exactArgs, type ParsedArgs } from "../args";
import { type CliContext, CliError, mayChange, resolveWorkspace } from "../context";
import { ago, clockAt, oneLine } from "../format";
import { type CliCommand, type CliOutput, output } from "../registry";
import {
  askPeerCli,
  changePeerCli,
  DEVICE_FLAG,
  deviceFlag,
  deviceRef,
  peerWorkspace,
  requirePeerCli,
  resolveDevice,
} from "../remote";
import { mayExecute } from "../sandbox";
import { openerOf, senderOf } from "../sender";
import { chatAgentFlag, resolveChat, SEND_TIMEOUT_MS } from "./chat";
import { chatProfiles, chatProfilesAdd, chatUsage } from "./chat-profiles";
import { peerCliChat } from "./chat-remote";
import { AGENT_NAMES } from "./chat-text";
import { WORKSPACE_FLAG } from "./flags";

interface ChatTarget {
  readonly workspace: WorkspaceMeta;
  readonly tab: CliTabInfo;
  readonly ref: { readonly workspaceId: string; readonly tabId: string };
}

async function chatTarget(
  ctx: CliContext,
  flags: ParsedArgs["flags"],
  selector: string,
): Promise<ChatTarget> {
  const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
  const tab = await resolveChat(ctx, workspace, selector);
  return { workspace, tab, ref: { workspaceId: workspace.id, tabId: tab.id } };
}

async function otherChat(
  ctx: CliContext,
  flags: ParsedArgs["flags"],
  selector: string,
): Promise<ChatTarget> {
  const target = await chatTarget(ctx, flags, selector);
  if (target.tab.id === ctx.caller.tabId) {
    throw new CliError("that is this tab; nexus changes only other tabs");
  }
  return target;
}

function claudeOnly({ tab }: ChatTarget, what: string): void {
  if (tab.type !== "claude") throw new CliError(`only a Claude tab can ${what}`);
}

function placeArg(text: string, what = "message"): number {
  const match = /^#?(\d+)$/.exec(text.trim());
  if (!match) {
    throw new CliUsageError(
      `<${what}> is the number chat read shows by it, not "${text}" (a shell drops a # and what follows)`,
    );
  }
  return Number(match[1]);
}

function named({ tab }: ChatTarget): string {
  return `${tab.title} (${shortId(tab.id)})`;
}

function when(at: number, now: number): string {
  const ahead = at > now;
  const hours = Math.abs(now - at) / 3_600_000;
  if (hours < 48) {
    if (!ahead) return ago(at, now);
    const minutes = Math.round((at - now) / 60_000);
    return minutes < 60 ? `in ${minutes}m` : `in ${Math.round(minutes / 60)}h`;
  }
  const days = Math.round(hours / 24);
  return ahead ? `in ${days}d` : `${days}d ago`;
}

const TODO_MARKS: Readonly<Record<string, string>> = {
  completed: "[x]",
  in_progress: "[>]",
};

export function panelText(title: string, panel: ChatPanel, now: number): string {
  const blocks: string[] = [];
  const block = (head: string, lines: readonly string[]) => {
    if (lines.length > 0) blocks.push([head, ...lines.map((l) => `  ${l}`)].join("\n"));
  };
  if (panel.goal) blocks.push(`Goal, ${panel.goal.status}: ${oneLine(panel.goal.condition, 300)}`);
  block(
    "To-dos:",
    panel.todos.map((todo) => `${TODO_MARKS[todo.status] ?? "[ ]"} ${oneLine(todo.content, 200)}`),
  );
  block(
    "Tasks (chat stop-task <tab> <id>):",
    panel.tasks.map((task) => {
      const doing = task.activity ? ` · ${oneLine(task.activity, 80)}` : "";
      return `${task.taskId}  ${task.status}  ${oneLine(task.description, 120)}${doing}`;
    }),
  );
  block(
    "Subagents:",
    panel.agents.map((agent) => `${agent.status}  ${oneLine(agent.description, 120)}`),
  );
  block(
    "Changed files:",
    panel.changedFiles.map((file) => {
      const counts = [
        file.added !== undefined ? `+${file.added}` : "",
        file.removed !== undefined ? `-${file.removed}` : "",
      ].filter(Boolean);
      return counts.length > 0 ? `${file.path}  ${counts.join(" ")}` : file.path;
    }),
  );
  const usage: string[] = [];
  if (panel.context) {
    const { usedTokens, maxTokens } = panel.context;
    const percent = Math.round((usedTokens / maxTokens) * 100);
    usage.push(
      `Context: ${usedTokens.toLocaleString("en-US")} of ${maxTokens.toLocaleString("en-US")} tokens (${percent}%)`,
    );
  }
  if (panel.costUsd !== undefined) usage.push(`Cost: $${panel.costUsd.toFixed(2)}`);
  if (panel.planLimits && panel.planLimits.length > 0) {
    const limits = panel.planLimits.map((meter) => {
      const name = meter.scope ? `${meter.kind} (${meter.scope})` : meter.kind;
      const resets = meter.resetsAt !== undefined ? `, resets ${when(meter.resetsAt, now)}` : "";
      return `${name} ${Math.round(meter.percent)}%${resets}`;
    });
    usage.push(`Plan limits: ${limits.join("; ")}`);
  }
  if (panel.rateLimit) {
    const resets =
      panel.rateLimit.resetsAt !== undefined
        ? `, resets ${when(panel.rateLimit.resetsAt, now)}`
        : "";
    usage.push(`Rate limit: ${panel.rateLimit.status}${resets}`);
  }
  const going = panel.limitResume && limitResumeLine(panel.limitResume, now);
  if (going) usage.push(`Usage limit: ${going}`);
  if (usage.length > 0) blocks.push(usage.join("\n"));
  if (panel.mcp && panel.mcp.length > 0) {
    blocks.push(
      `MCP: ${panel.mcp.map((server) => `${server.name} (${server.status})`).join(", ")}`,
    );
  }
  if (panel.remoteControl?.available) {
    const { enabled, url } = panel.remoteControl;
    blocks.push(`Remote Control: ${enabled ? `on${url ? ` (${url})` : ""}` : "off"}`);
  }
  block(
    "Held messages (chat unsend / chat edit <tab> <id>):",
    (panel.held ?? []).map((held) => {
      const carries = [
        held.images ? `${held.images} image${held.images === 1 ? "" : "s"}` : "",
        held.files ? `${held.files} file${held.files === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      const extra = carries.length > 0 ? ` [${carries.join(", ")}]` : "";
      return `${held.id}  ${oneLine(held.text, 200)}${extra}`;
    }),
  );
  return blocks.length > 0 ? `${title}\n\n${blocks.join("\n\n")}` : `${title}: its panel is empty.`;
}

function limitResumeLine(
  resume: NonNullable<ChatPanel["limitResume"]>,
  now: number,
): string | undefined {
  const resets = resume.resetsAt !== undefined ? `, resets ${clockAt(resume.resetsAt, now)}` : "";
  switch (resume.state) {
    case "waiting":
      return resume.at !== undefined
        ? `reached; the app sends a message to go on at ${clockAt(resume.at, now)}`
        : `reached${resets}`;
    case "unknown":
      return "reached; when it resets is not known, so nothing goes on by itself";
    case "cancelled":
      return `reached${resets}; going on by itself was cancelled`;
    case "gave_up":
      return `still reached after ${resume.tries ?? 0} tries${resets}; the app no longer goes on by itself`;
    default:
      return undefined;
  }
}

function withoutAccount(panel: ChatPanel): ChatPanel {
  if (!panel.session?.account) return panel;
  const { account: _, ...session } = panel.session;
  return { ...panel, session };
}

const chatPanel: CliCommand = {
  path: ["chat", "panel"],
  summary: "Print what a Claude or Codex tab's side panel shows",
  args: "<tab>",
  details:
    "Its goal, to-dos, tasks (background runs, by the id chat stop-task takes), subagents,\n" +
    "changed files, context window, cost, plan limits, MCP servers, Remote Control, and the\n" +
    "messages held for after the turn (by the id chat unsend and chat edit take).",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      const target = await peerCliChat(ctx, device, flags, selector);
      const panel = withoutAccount(await askPeerCli(ctx, device, "chat.panel", target.ref));
      return output(panelText(target.title, panel, ctx.services.clock.now()), {
        ...target.json,
        ...panel,
      });
    }
    const target = await chatTarget(ctx, flags, selector);
    const panel = withoutAccount(await ctx.services.ui("chat.panel", target.ref));
    return output(panelText(named(target), panel, ctx.services.clock.now()), {
      ...target.ref,
      ...panel,
    });
  },
};

const chatUnsend: CliCommand = {
  path: ["chat", "unsend"],
  summary: "Take back a message a Claude or Codex tab holds for after its turn, or has not read",
  args: "<tab> <message>",
  details:
    "<message> is a held message's id (chat send --after prints it, chat panel lists them):\n" +
    "it is taken back whole and its text printed. Or the number chat read shows by a message\n" +
    "sent during a Claude tab's turn that it marks unread: taken back while Claude has not\n" +
    "read it.",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, message] = exactArgs(positionals, "tab", "message") as [string, string];
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      const target = await peerCliChat(ctx, device, flags, selector);
      if (!/^#?\d+$/.test(message)) {
        const { text } = await changePeerCli(ctx, device, "chat.unqueue", {
          ...target.ref,
          id: message,
        });
        return output(`Took back the held message from ${target.title}:\n${text}`, {
          ...target.json,
          id: message,
          text,
        });
      }
      if (target.peer.session.kind !== "claude")
        throw new CliError("only Claude can withdraw a message it has not read");
      const i = placeArg(message);
      const item = await askPeerCli(ctx, device, "chat.entryItem", { ...target.ref, i });
      if (item.kind !== "user") throw new CliError(`#${i} is not a message sent to it`);
      const { withdrawn } = await changePeerCli(ctx, device, "chat.withdraw", {
        ...target.ref,
        itemKey: item.itemKey,
      });
      return output(
        withdrawn ? `Took back #${i} from ${target.title}.` : `#${i} was read already; it stays.`,
        { ...target.json, i, withdrawn, ...(item.text !== undefined ? { text: item.text } : {}) },
        { exitCode: withdrawn ? 0 : 1 },
      );
    }
    const target = await otherChat(ctx, flags, selector);
    await mayChange(ctx, target.workspace, { kind: "chatInput", detail: target.tab.title });
    if (!/^#?\d+$/.test(message)) {
      const { text } = await ctx.services.ui("chat.unqueue", { ...target.ref, id: message });
      return output(`Took back the held message from ${named(target)}:\n${text}`, {
        ...target.ref,
        id: message,
        text,
      });
    }
    claudeOnly(target, "take back a message it has not read");
    const i = placeArg(message);
    const item = await ctx.services.ui("chat.entryItem", { ...target.ref, i });
    if (item.kind !== "user") throw new CliError(`#${i} is not a message sent to it`);
    const { withdrawn } = await ctx.services.ui("chat.withdraw", {
      ...target.ref,
      itemKey: item.itemKey,
    });
    if (!withdrawn) {
      return output(
        `#${i} was read already; it stays.`,
        { ...target.ref, i, withdrawn },
        { exitCode: 1 },
      );
    }
    return output(`Took back #${i} from ${named(target)}.`, {
      ...target.ref,
      i,
      withdrawn,
      ...(item.text !== undefined ? { text: item.text } : {}),
    });
  },
};

function textOf(ctx: CliContext, words: readonly string[]): string {
  const fromStdin = words.length === 1 && words[0] === "-";
  return (fromStdin ? (ctx.invocation.stdin ?? "").replace(/\r?\n$/, "") : words.join(" ")).trim();
}

const chatEdit: CliCommand = {
  path: ["chat", "edit"],
  summary: "Change the text of a message a Claude or Codex tab holds for after its turn",
  args: "<tab> <id> <text...>",
  details:
    'Its images and files stay. <id> as chat send --after prints it, or chat panel lists it. "-"\n' +
    "reads the text from standard input.",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, id, ...words] = positionals;
    if (selector === undefined) throw new CliUsageError("missing <tab>");
    if (id === undefined) throw new CliUsageError("missing <id>");
    const text = textOf(ctx, words);
    if (text === "") throw new CliUsageError("missing <text>");
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      const target = await peerCliChat(ctx, device, flags, selector);
      await changePeerCli(ctx, device, "chat.editHeld", { ...target.ref, id, text });
      return output(`Changed the held message ${id} of ${target.title}.`, {
        ...target.json,
        id,
        text,
      });
    }
    const target = await otherChat(ctx, flags, selector);
    await mayExecute(
      ctx,
      target.workspace,
      {
        kind: "chatInput",
        detail: target.tab.title,
        body: text,
      },
      { target: target.tab },
    );
    await ctx.services.ui("chat.editHeld", { ...target.ref, id, text });
    return output(`Changed the held message ${id} of ${named(target)}.`, {
      ...target.ref,
      id,
      text,
    });
  },
};

const chatRewind: CliCommand = {
  path: ["chat", "rewind"],
  summary: "Rewind a Claude or Codex tab to before a user message",
  args: "<tab> <message>",
  details:
    "As its rewind button does: the conversation goes back to before the message (the number\n" +
    "chat read shows by it). Claude's --files also restores files; Codex rewinds only the chat.\n" +
    "--preview checks the target and shows what can be restored. Rewinding needs user approval.",
  flags: {
    files: { type: "boolean", description: "Undo Claude's changes to the files since, too" },
    preview: { type: "boolean", description: "Only print what would be undone in the files" },
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, message] = exactArgs(positionals, "tab", "message") as [string, string];
    const i = placeArg(message);
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      const target = await peerCliChat(ctx, device, flags, selector);
      const withFiles = flags.files === true;
      const codex = target.peer.session.kind === "codex";
      if (codex && withFiles) throw new CliError("Codex conversation rewind cannot restore files");
      const item = await askPeerCli(ctx, device, "chat.entryItem", { ...target.ref, i });
      if (item.kind !== "user") throw new CliError(`#${i} is not a message sent to it`);
      const ref = { ...target.ref, itemKey: item.itemKey };
      if (flags.preview === true) {
        const preview = await askPeerCli(ctx, device, "chat.rewindPreview", ref);
        const text = codex
          ? "Codex can rewind the conversation. File restoration is unavailable."
          : preview.canRewind
            ? `Files to restore: ${preview.filesChanged.join(", ") || "none"}`
            : (preview.error ?? "File restoration is unavailable.");
        return output(text, { ...target.json, i, ...preview });
      }
      await changePeerCli(ctx, device, "chat.rewind", { ...ref, files: withFiles });
      return output(`Rewound ${target.title} to before #${i}.`, {
        ...target.json,
        i,
        files: withFiles,
      });
    }
    const target = await (flags.preview === true ? chatTarget : otherChat)(ctx, flags, selector);
    const codex = target.tab.type === "codex";
    const withFiles = flags.files === true;
    if (codex && withFiles) throw new CliError("Codex conversation rewind cannot restore files");
    const item = await ctx.services.ui("chat.entryItem", { ...target.ref, i });
    if (item.kind !== "user") throw new CliError(`#${i} is not a message sent to it`);
    const preview = await ctx.services.ui("chat.rewindPreview", {
      ...target.ref,
      itemKey: item.itemKey,
    });
    const files =
      preview.filesChanged.length === 0
        ? "no file changes to undo"
        : `${preview.filesChanged.length} file${preview.filesChanged.length === 1 ? "" : "s"} (+${preview.insertions} -${preview.deletions}):\n${preview.filesChanged.map((f) => `  ${f}`).join("\n")}`;
    if (flags.preview === true) {
      if (codex) {
        return output(
          `Codex can rewind the conversation to before #${i}. It cannot restore files.`,
          {
            ...target.ref,
            i,
            ...preview,
          },
        );
      }
      const why = preview.canRewind ? "" : `\nIts files cannot be rewound: ${preview.error ?? ""}`;
      return output(`Rewinding to before #${i} with --files undoes ${files}${why}`, {
        ...target.ref,
        i,
        ...preview,
      });
    }
    if (withFiles && !preview.canRewind) {
      throw new CliError(`its files cannot be rewound${preview.error ? `: ${preview.error}` : ""}`);
    }
    await ctx.services.askUser(
      {
        fromWorkspaceId: ctx.caller.workspaceId,
        fromTabId: ctx.caller.tabId,
        toWorkspaceId: target.workspace.id,
        change: {
          kind: withFiles ? "chatRewindFiles" : "chatRewind",
          detail: `"${target.tab.title}" (#${i})`,
          body: [item.text ?? "", withFiles ? files : ""].filter(Boolean).join("\n\n"),
        },
      },
      ctx.signal,
    );
    await ctx.services.ui(
      "chat.rewind",
      { ...target.ref, itemKey: item.itemKey, files: withFiles },
      SEND_TIMEOUT_MS,
    );
    const undone = withFiles ? ` and undid ${files}` : "";
    return output(`Rewound ${named(target)} to before #${i}${undone}.`, {
      ...target.ref,
      i,
      files: withFiles,
      ...(item.text !== undefined ? { text: item.text } : {}),
    });
  },
};

const chatFork: CliCommand = {
  path: ["chat", "fork"],
  summary: "Fork a Claude or Codex conversation into a new tab",
  args: "<tab> [message]",
  details:
    "As its fork buttons do, the new tab opening behind what the window shows: with no\n" +
    "<message>, all of the conversation; from an answer (the number chat read shows by it), up\n" +
    "to it; from a message sent to it, what came before it, the message printed to send again.",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    if (positionals.length > 2) throw new CliUsageError("too many arguments");
    const [selector, message] = positionals;
    if (selector === undefined) throw new CliUsageError("missing <tab>");
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      const target = await peerCliChat(ctx, device, flags, selector);
      const item =
        message === undefined
          ? undefined
          : await askPeerCli(ctx, device, "chat.entryItem", {
              ...target.ref,
              i: placeArg(message),
            });
      const reply = await changePeerCli(ctx, device, "chat.fork", {
        ...target.ref,
        ...(item ? { itemKey: item.itemKey } : {}),
      });
      const text = `Forked ${target.title} into tab ${shortId(reply.tabId)}.`;
      return output(reply.draft ? `${text}\nDraft to resend:\n${reply.draft}` : text, {
        ...target.json,
        from: target.ref.tabId,
        ...reply,
      });
    }
    const target = await chatTarget(ctx, flags, selector);
    await mayExecute(ctx, target.workspace, { kind: "chatFork", detail: target.tab.title });
    const itemKey =
      message === undefined
        ? undefined
        : (await ctx.services.ui("chat.entryItem", { ...target.ref, i: placeArg(message) }))
            .itemKey;
    const openedBy = openerOf(await senderOf(ctx));
    ctx.signal?.throwIfAborted();
    const { tabId, draft } = await ctx.services.ui(
      "chat.fork",
      { ...target.ref, ...(itemKey ? { itemKey } : {}), ...(openedBy ? { openedBy } : {}) },
      SEND_TIMEOUT_MS,
    );
    const reach =
      target.workspace.id === ctx.caller.workspaceId
        ? ""
        : ` --workspace ${shortId(target.workspace.id)}`;
    const resend = draft
      ? `\nIts message was not sent; to send it:\n  nexus chat send ${shortId(tabId)}${reach} -  (the text below on standard input)\n${draft}`
      : "";
    return output(`Forked ${named(target)} into tab ${shortId(tabId)}.${resend}`, {
      tabId,
      workspaceId: target.workspace.id,
      from: target.tab.id,
      ...(draft ? { draft } : {}),
    });
  },
};

const chatBackground: CliCommand = {
  path: ["chat", "background"],
  summary: "Send a Claude tab's running command or subagent to the background",
  args: "<tab> <call>",
  details:
    "As its call's background button does: the turn goes on while it runs, as a task chat\n" +
    "panel lists. <call> is the number chat read shows by the call, or the call's id.",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, call] = exactArgs(positionals, "tab", "call") as [string, string];
    const target = await otherChat(ctx, flags, selector);
    claudeOnly(target, "send a call to the background");
    const tool = await ctx.services.ui("chat.tool", { ...target.ref, ref: call.replace(/^#/, "") });
    await mayChange(ctx, target.workspace, {
      kind: "chatBackground",
      detail: `${tool.name} (${target.tab.title})`,
    });
    await ctx.services.ui("chat.background", { ...target.ref, toolUseId: tool.toolUseId });
    return output(`Sent ${tool.name} (#${tool.i}) of ${named(target)} to the background.`, {
      ...target.ref,
      i: tool.i,
      toolUseId: tool.toolUseId,
    });
  },
};

const chatStopTask: CliCommand = {
  path: ["chat", "stop-task"],
  summary: "Stop one of a Claude tab's tasks (a background run)",
  args: "<tab> <task>",
  details: "As the stop button by it in its panel does; <task> is its id, as chat panel lists it.",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, taskId] = exactArgs(positionals, "tab", "task") as [string, string];
    const target = await otherChat(ctx, flags, selector);
    claudeOnly(target, "stop a task");
    await mayChange(ctx, target.workspace, {
      kind: "chatTaskStop",
      detail: `${taskId} (${target.tab.title})`,
    });
    await ctx.services.ui("chat.stopTask", { ...target.ref, taskId });
    return output(`Stopped the task ${taskId} of ${named(target)}.`, { ...target.ref, taskId });
  },
};

const chatRemoteControl: CliCommand = {
  path: ["chat", "remote-control"],
  summary: "Turn a Claude tab's Remote Control on or off",
  args: "<tab> <on|off>",
  details:
    "As the switch in its panel does: with it on, the session can be driven from claude.ai\n" +
    "and the Claude app, at the address printed. Follows the workspace change policy.",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, turn] = exactArgs(positionals, "tab", "on|off") as [string, string];
    if (turn !== "on" && turn !== "off") throw new CliUsageError('it is "on" or "off"');
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      const target = await peerCliChat(ctx, device, flags, selector);
      if (target.peer.session.kind !== "claude")
        throw new CliError("Remote Control is available only in Claude");
      const enabled = turn === "on";
      const result = await changePeerCli(ctx, device, "chat.remoteControl", {
        ...target.ref,
        enabled,
      });
      return remoteControlOutput(target.title, target.json, {
        ...result,
        enabled: result.enabled ?? enabled,
      });
    }
    const target = await otherChat(ctx, flags, selector);
    claudeOnly(target, "have Remote Control");
    return setRemoteControl(ctx, target, turn === "on");
  },
};

async function setRemoteControl(
  ctx: CliContext,
  target: ChatTarget,
  enabled?: boolean,
): Promise<CliOutput> {
  const kind =
    enabled === undefined
      ? "chatRemoteControlToggle"
      : enabled
        ? "chatRemoteControlOn"
        : "chatRemoteControlOff";
  if (enabled === false) await mayChange(ctx, target.workspace, { kind, detail: target.tab.title });
  else await mayExecute(ctx, target.workspace, { kind, detail: target.tab.title });
  return remoteControlOutput(
    named(target),
    target.ref,
    await applyRemoteControl(ctx.services, target.ref, enabled),
  );
}

const RUNS: Readonly<Record<ChatCommand["runs"], string>> = {
  command: "chat command",
  send: "chat send",
  settings: "chat set",
};

const chatCommandsList: CliCommand = {
  path: ["chat", "commands"],
  summary: "List the slash commands nexus can run in a Claude or Codex tab",
  args: "<tab>",
  details:
    "The agent's own, which go to it as a message; the app's own that change the\n" +
    "conversation; the model and effort, which chat set sets. chat command runs the first two.",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const device = await resolveDevice(ctx, deviceFlag(flags));
    const list = async () => {
      if (device) {
        const target = await peerCliChat(ctx, device, flags, selector);
        return {
          title: target.title,
          ref: target.json,
          ...(await askPeerCli(ctx, device, "chat.commands", target.ref)),
        };
      }
      const target = await chatTarget(ctx, flags, selector);
      return {
        title: named(target),
        ref: target.ref,
        ...(await ctx.services.ui("chat.commands", target.ref, SEND_TIMEOUT_MS)),
      };
    };
    const { title, ref, commands } = await list();
    const lines = commands.map((command) => {
      const args = command.args ? ` ${command.args}` : "";
      return `/${command.name}${args}  ${oneLine(command.description, 100)}  (${RUNS[command.runs]})`;
    });
    return output(lines.length > 0 ? lines.join("\n") : `${title} has no commands.`, {
      ...ref,
      commands,
    });
  },
};

const chatCommandRun: CliCommand = {
  path: ["chat", "command"],
  summary: "Run a slash command in a Claude or Codex tab",
  args: "<tab> <command> [args...]",
  details:
    "As its composer runs it typed: <command> as chat commands lists it, with or without\n" +
    "its /. The agent's own go to it as a message; the app's own print what they said, and\n" +
    "the tab they opened. The model and effort are chat set's.",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, typed, ...words] = positionals;
    if (selector === undefined) throw new CliUsageError("missing <tab>");
    if (typed === undefined) throw new CliUsageError("missing <command>");
    const name = typed.replace(/^\//, "");
    const args = words.join(" ").trim();
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      const target = await peerCliChat(ctx, device, flags, selector);
      const reply = await changePeerCli(ctx, device, "chat.command", {
        ...target.ref,
        name,
        ...(args ? { args } : {}),
      });
      if (reply.remoteControl)
        return remoteControlOutput(target.title, target.json, reply.remoteControl);
      return output(
        [
          `Ran /${name} in ${target.title}.`,
          reply.message,
          reply.tabId ? `It opened tab ${shortId(reply.tabId)}.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        {
          ...target.json,
          command: name,
          ...(reply.message ? { message: reply.message } : {}),
          ...(reply.tabId ? { opened: reply.tabId } : {}),
        },
      );
    }
    const target = await otherChat(ctx, flags, selector);
    const lower = name.toLowerCase();
    if (target.tab.type === "claude" && remoteControlCommand(`/${name}`)) {
      return setRemoteControl(ctx, target);
    }
    const text = `/${name}${args ? ` ${args}` : ""}`;
    await mayExecute(
      ctx,
      target.workspace,
      {
        kind: "chatInput",
        detail: target.tab.title,
        body: text,
      },
      lower === "fork" || lower === "new" || lower === "clear" ? {} : { target: target.tab },
    );
    const { commands } = await ctx.services.ui("chat.commands", target.ref, SEND_TIMEOUT_MS);
    const command =
      commands.find((c) => c.name.toLowerCase() === lower) ??
      commands.find((c) => c.aliases?.some((alias) => alias.toLowerCase() === lower));
    if (!command) {
      throw new CliError(`${target.tab.title} has no command /${name}; chat commands lists them`);
    }
    if (command.runs === "settings") {
      throw new CliError(`/${name} is set with chat set --${command.sets ?? name}`);
    }
    if (command.runs === "send") {
      const from = await senderOf(ctx);
      await ctx.services.ui(
        "chat.send",
        { ...target.ref, text, ...(from ? { from: { ...from, waits: false } } : {}) },
        SEND_TIMEOUT_MS,
      );
      return output(`Sent ${text} to ${named(target)}.`, {
        ...target.ref,
        command: command.name,
        text,
      });
    }
    const { message, tabId } = await ctx.services.ui(
      "chat.command",
      { ...target.ref, name: command.name, ...(args ? { args } : {}) },
      SEND_TIMEOUT_MS,
    );
    const lines = [
      `Ran ${text} in ${named(target)}.`,
      ...(message ? [message] : []),
      ...(tabId ? [`It opened tab ${shortId(tabId)}.`] : []),
    ];
    return output(lines.join("\n"), {
      ...target.ref,
      command: command.name,
      ...(message ? { message } : {}),
      ...(tabId ? { opened: tabId } : {}),
    });
  },
};

const AGENT_FLAG = {
  type: "string",
  value: "AGENT",
  description: "claude (default) or codex",
} as const;

function pastLine(
  session: Pick<
    CliPastSession,
    "title" | "at" | "sessionId" | "tabId" | "firstPrompt" | "gitBranch"
  > & { profile?: string },
  now: number,
): string {
  const title = oneLine(session.title || session.firstPrompt || "(untitled)", 80);
  const about = [
    when(session.at, now),
    session.profile && session.profile !== "default" ? `profile ${session.profile}` : "",
    session.gitBranch ? `on ${session.gitBranch}` : "",
    session.tabId ? `open in ${shortId(session.tabId)}` : "",
  ].filter(Boolean);
  return `${session.sessionId}  ${title}  (${about.join(", ")})`;
}

const chatHistory: CliCommand = {
  path: ["chat", "history"],
  summary: "List the past Claude or Codex conversations of a workspace's folder",
  args: "[words...]",
  details:
    "Newest first, as a new tab's list of past conversations shows them: those whose title or\n" +
    "first prompt has every word given. chat resume goes on with one.",
  flags: {
    agent: AGENT_FLAG,
    limit: { type: "number", value: "N", description: "At most N (default 20)" },
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const agent = chatAgentFlag(flags.agent, "claude");
    const limit = (flags.limit as number | undefined) ?? 20;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CliUsageError("--limit takes a positive whole number");
    }
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) requirePeerCli(ctx, device);
    const workspace = device
      ? await peerWorkspace(ctx, device, flags.workspace)
      : resolveWorkspace(ctx, flags.workspace as string | undefined);
    const query = positionals.join(" ").trim();
    const params = { workspaceId: workspace.id, agent, ...(query ? { query } : {}), limit };
    const { sessions } = device
      ? await askPeerCli(ctx, device, "history.list", { ...params, limit: Math.min(limit, 200) })
      : await ctx.services.ui("chat.history", params);
    const now = ctx.services.clock.now();
    const text =
      sessions.length === 0
        ? `No past ${AGENT_NAMES[agent]} conversations${query ? ` with "${query}"` : ""} in ${workspace.name}.`
        : sessions.map((s) => pastLine(s, now)).join("\n");
    return output(
      text,
      {
        workspaceId: workspace.id,
        agent,
        sessions,
        ...(device ? { device: deviceRef(device) } : {}),
      },
      { records: sessions },
    );
  },
};

async function pastSession(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  agent: ChatAgent,
  id: string,
): Promise<CliPastSession> {
  const { sessions } = await ctx.services.ui("chat.history", { workspaceId: workspace.id, agent });
  const exact = sessions.find((s) => s.sessionId === id);
  if (exact) return exact;
  const found = sessions.filter((s) => s.sessionId.startsWith(id));
  if (found.length === 1) return found[0] as CliPastSession;
  throw new CliError(
    found.length === 0
      ? `no past ${AGENT_NAMES[agent]} conversation ${id} in ${workspace.name}; chat history lists them`
      : `${found.length} past conversations start with ${id}; give more of it`,
  );
}

const chatResume: CliCommand = {
  path: ["chat", "resume"],
  summary: "Go on with a past Claude or Codex conversation",
  args: "<session>",
  details:
    "In a new tab behind what the window shows, or in --tab, one of the agent's with no\n" +
    "conversation yet; the tab that has it open already, if one does. <session> is its id, as\n" +
    "chat history lists it, or its start.",
  flags: {
    agent: AGENT_FLAG,
    tab: { type: "string", value: "TAB", description: "Go on with it in this empty tab" },
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [id] = exactArgs(positionals, "session") as [string];
    const agent = chatAgentFlag(flags.agent, "claude");
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      requirePeerCli(ctx, device);
      const workspace = await peerWorkspace(ctx, device, flags.workspace);
      const into =
        typeof flags.tab === "string"
          ? await peerCliChat(ctx, device, flags, flags.tab)
          : undefined;
      if (into && (into.ref.workspaceId !== workspace.id || into.peer.session.kind !== agent))
        throw new CliUsageError("--tab must name a tab of the selected agent in --workspace");
      const { tabId } = await changePeerCli(ctx, device, "chat.resume", {
        workspaceId: workspace.id,
        agent,
        sessionId: id,
        ...(into ? { tabId: into.ref.tabId } : {}),
      });
      return output(`Resumed ${id} in tab ${shortId(tabId)} on "${device.name}".`, {
        tabId,
        workspaceId: workspace.id,
        agent,
        device: deviceRef(device),
      });
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const session = await pastSession(ctx, workspace, agent, id);
    const into =
      typeof flags.tab === "string" ? await resolveChat(ctx, workspace, flags.tab) : undefined;
    if (into?.id === ctx.caller.tabId) throw new CliError("that is this tab");
    await mayExecute(ctx, workspace, { kind: "chatNew", detail: AGENT_NAMES[agent] });
    const openedBy = openerOf(await senderOf(ctx));
    ctx.signal?.throwIfAborted();
    const { tabId } = await ctx.services.ui(
      "chat.resume",
      {
        workspaceId: workspace.id,
        agent,
        sessionId: session.sessionId,
        ...(into ? { tabId: into.id, emptyOnly: true } : {}),
        ...(openedBy ? { openedBy } : {}),
      },
      SEND_TIMEOUT_MS,
    );
    const title = oneLine(session.title || session.firstPrompt || session.sessionId, 80);
    return output(`Went on with "${title}" in tab ${shortId(tabId)}.`, {
      tabId,
      workspaceId: workspace.id,
      agent,
      sessionId: session.sessionId,
    });
  },
};

const chatFiles: CliCommand = {
  path: ["chat", "files"],
  summary: "List file suggestions for the chat composer's @ picker",
  args: "<tab> [query]",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, query = "", ...extra] = positionals;
    if (selector === undefined || extra.length) throw new CliUsageError("give <tab> [query]");
    if (query.length > 256) throw new CliUsageError("the query is at most 256 characters");
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      const target = await peerCliChat(ctx, device, flags, selector);
      const { paths } = await askPeerCli(ctx, device, "chat.fileSuggestions", {
        ...target.ref,
        query,
      });
      return output(paths.join("\n"), { ...target.json, paths }, { records: paths });
    }
    const target = await chatTarget(ctx, flags, selector);
    const { paths } = await ctx.services.ui("chat.fileSuggestions", { ...target.ref, query });
    return output(paths.join("\n"), { ...target.ref, paths }, { records: paths });
  },
};

export const chatControlCommands: CliCommand[] = [
  chatPanel,
  chatUnsend,
  chatEdit,
  chatRewind,
  chatFork,
  chatBackground,
  chatStopTask,
  chatRemoteControl,
  chatCommandsList,
  chatCommandRun,
  chatHistory,
  chatProfiles,
  chatProfilesAdd,
  chatUsage,
  chatFiles,
  chatResume,
];

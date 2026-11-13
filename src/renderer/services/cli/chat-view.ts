/**
 * A Claude or Codex tab's conversation as the nexus CLI tells it: where it
 * stands (chat state, chat wait), its messages (chat read) and a tool call
 * whole (chat tool). Pure.
 */

import { type RelayedMessage, RelaySenderSchema } from "../../../shared/chat/relay";
import type {
  CliChatEntry,
  CliChatGoal,
  CliChatInfo,
  CliChatRequest,
  CliChatTool,
  CliChatWaiting,
} from "../../../shared/cli/ui";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { lastAnswer } from "../agent-sessions/codex-state";
import { chatRowFacts, inputTarget } from "../agent-sessions/rows";
import { shownGoalOf } from "../chat/goal";
import { type ChatItem, type ChatModel, opensTurn, type ToolCall } from "../chat/model";
import { followsMessage } from "../chat/profile-moves";
import { relaySenderText, withRelayed } from "../chat/relayed";
import type { ChatTabState } from "../chat/store";

/** What a tab asks the user, in a line: the question, the plan, or the tool to allow. */
function askedOf(model: ChatModel): string | undefined {
  const wait = chatRowFacts(model).wait;
  if (!wait) return undefined;
  switch (wait.kind) {
    case "question":
      return wait.text ? `asks: ${wait.text}` : "asks a question";
    case "plan":
      return wait.text ? `has a plan to approve: ${wait.text}` : "has a plan to approve";
    case "permission":
      return `asks to run ${wait.tool}${wait.target ? ` ${wait.target}` : ""}`;
  }
}

/** What a tab asks the user for, in a line; none while it asks nothing. */
function waitingOf(model: ChatModel): CliChatWaiting | undefined {
  const wait = chatRowFacts(model).wait;
  if (!wait) return undefined;
  if (wait.kind === "permission") {
    return { kind: "permission", text: wait.target ? `${wait.tool} ${wait.target}` : wait.tool };
  }
  return { kind: wait.kind, text: wait.text };
}

/** How much of a request's input is told: a command is whole well under it. */
const REQUEST_CHARS = 8_000;

/**
 * The tool's permission request a tab waits on, whole: what an answer lets
 * run, not the line the tab's row shows. None for a question or a plan.
 */
function requestOf(model: ChatModel): CliChatRequest | undefined {
  const request = model.permissions[0];
  if (!request || request.toolName === "AskUserQuestion" || request.toolName === "ExitPlanMode") {
    return undefined;
  }
  const input = (request.preview?.input ?? request.input) as Record<string, unknown>;
  const whole = typeof input.command === "string" ? input.command : JSON.stringify(input, null, 2);
  return {
    id: request.requestId,
    tool: request.displayName || request.toolName,
    input: whole.length > REQUEST_CHARS ? `${whole.slice(0, REQUEST_CHARS - 1)}…` : whole,
  };
}

/** The error a tab's last turn ended on, when it did. */
function turnError(model: ChatModel): string | undefined {
  if (!model.lastResult?.isError) return undefined;
  for (let i = model.items.length - 1; i >= 0; i--) {
    const item = model.items[i];
    if (opensTurn(item)) return undefined;
    if (item.kind === "notice" && item.code === "error") return item.detail ?? "the turn failed";
  }
  return model.lastResult.subtype;
}

/** When the conversation last moved: its turn's start while one runs, else its last item. */
function sinceOf(model: ChatModel): number | undefined {
  if (model.running && model.turn?.startedAt !== undefined) return model.turn.startedAt;
  for (let i = model.items.length - 1; i >= 0; i--) {
    const at = model.items[i]?.at;
    if (at !== undefined) return at;
  }
  return undefined;
}

/** The goal a tab shows (/goal): none once its bar was closed after it ended. */
function goalOf(chat: ChatTabState): CliChatGoal | undefined {
  const goal = shownGoalOf(chat);
  if (!goal) return undefined;
  return {
    objective: goal.objective,
    status: goal.status,
    ...(goal.ended && goal.reason ? { reason: goal.reason } : {}),
  };
}

/**
 * Where a tab stands. `unseen`: a message was sent that its conversation
 * does not show yet, so it counts as working before any turn begins.
 */
export function chatInfoOf(
  agent: ChatAgent,
  chat: ChatTabState | undefined,
  unseen: boolean,
): CliChatInfo {
  if (!chat) return { agent, state: unseen ? "working" : "idle" };
  const { model } = chat;
  const since = sinceOf(model);
  const goal = goalOf(chat);
  const at = { ...(since === undefined ? {} : { since }), ...(goal ? { goal } : {}) };
  if (chat.phase === "failed" || chat.phase === "not-found") {
    const message =
      chat.phase === "not-found" ? `${agent} was not found where the workspace runs` : chat.error;
    return { agent, state: "error", ...(message ? { message } : {}), ...at };
  }
  const asked = model.permissions.length > 0 ? askedOf(model) : undefined;
  if (asked) {
    const request = requestOf(model);
    const waiting = waitingOf(model);
    return {
      agent,
      state: "asking",
      message: asked,
      ...(request ? { request } : {}),
      ...(waiting ? { waiting } : {}),
      ...at,
    };
  }
  const answer = lastAnswer(model);
  const told = answer ? { message: answer } : {};
  if (unseen || model.running || chat.phase === "starting" || chat.phase === "held") {
    return { agent, state: "working", ...told, ...at };
  }
  const error = turnError(model);
  if (error) return { agent, state: "error", message: error, ...at };
  return { agent, state: "idle", ...told, ...at };
}

/** An entry before its place in the conversation is counted. */
type Entry = Omit<CliChatEntry, "i">;

function toolEntry(call: ToolCall | undefined): Entry | null {
  if (!call) return null;
  const target = inputTarget(call.name, call.input);
  const failed =
    call.status === "error" ? " (failed)" : call.status === "denied" ? " (denied)" : "";
  return {
    role: "tool",
    text: `${call.displayName || call.name}${target ? ` ${target}` : ""}${failed}`,
    toolUseId: call.id,
    status: call.status,
    ...(call.parentToolUseId ? { parentToolUseId: call.parentToolUseId } : {}),
  };
}

function entriesOfItem(item: ChatItem, tools: ChatModel["tools"]): Entry[] {
  switch (item.kind) {
    case "user": {
      const images = item.images.length;
      const attached = images === 0 ? "" : ` [${images} image${images === 1 ? "" : "s"}]`;
      return [{ role: "user", text: `${item.text.trim()}${attached}` }];
    }
    case "assistant": {
      const entries: Entry[] = [];
      let text: string[] = [];
      const flush = () => {
        const joined = text.join("\n\n").trim();
        if (joined !== "") entries.push({ role: "agent", text: joined });
        text = [];
      };
      for (const block of item.blocks) {
        if (block.type === "text") text.push(block.text);
        if (block.type !== "tool") continue;
        flush();
        const entry = toolEntry(tools[block.toolUseId]);
        if (entry) entries.push(entry);
      }
      flush();
      return entries;
    }
    case "notice":
      return [{ role: "notice", text: item.detail ? `${item.code}: ${item.detail}` : item.code }];
    case "received": {
      const relayed = relaySenderText(item.from);
      if (relayed) {
        const { kind, agent, name, workspaceId, tabId } = item.from;
        const from = RelaySenderSchema.safeParse({ kind, agent, name, workspaceId, tabId });
        return [
          {
            role: "notice",
            text: `from ${relayed}: ${item.text}`,
            ...(from.success ? { from: from.data } : {}),
          },
        ];
      }
      const from = item.from.name ? `${item.from.kind} ${item.from.name}` : item.from.kind;
      return [{ role: "notice", text: `from ${from}: ${item.text}` }];
    }
    case "task_end": {
      const what = item.description ?? item.summary ?? item.taskId;
      return [{ role: "notice", text: `task ${item.status}: ${what}` }];
    }
    case "shell": {
      const out = [item.stdout, item.stderr].filter(Boolean).join("\n");
      return [{ role: "notice", text: `$ ${item.command}${out ? `\n${out}` : ""}` }];
    }
  }
}

/** What the tab keeps beside its conversation, which a read tells in it. */
export interface ChatTabExtras {
  /** The messages other agents sent it through the nexus command: told as theirs. */
  readonly relayed?: readonly RelayedMessage[];
  /** Where it went on in another profile, by the profile's name: a notice after the message. */
  readonly moves?: readonly { readonly after: string; readonly profile: string }[];
}

/**
 * Every entry of a tab's conversation, its history before the program's log
 * included, each with its place: what the user and the agent said, the tools
 * the agent and its subagents ran, and what the app noted.
 */
function allEntries(
  chat: ChatTabState,
  extras: ChatTabExtras = {},
): {
  entries: CliChatEntry[];
  tools: ChatModel["tools"];
} {
  const { history, model } = chat;
  const items = withRelayed(
    history ? [...history.items, ...model.items] : model.items,
    extras.relayed,
  );
  const tools = history ? { ...history.tools, ...model.tools } : model.tools;
  // Each move after the last item of the message it follows, as the tab shows it.
  const movesAfter = new Map<ChatItem, string[]>();
  for (const move of extras.moves ?? []) {
    const item = items.findLast((i) => followsMessage(i, move.after));
    if (item) movesAfter.set(item, [...(movesAfter.get(item) ?? []), move.profile]);
  }
  const entries = items
    .flatMap((item): Entry[] => {
      const own = entriesOfItem(item, tools);
      const moved = movesAfter.get(item) ?? [];
      return [
        ...own,
        ...moved.map(
          (profile): Entry => ({
            role: "notice",
            text: `went on in profile ${JSON.stringify(profile)}`,
          }),
        ),
      ];
    })
    .map((entry, i) => ({ i, ...entry }));
  return { entries, tools };
}

export interface ChatEntriesQuery extends ChatTabExtras {
  /** Only those after the entry with this i. */
  readonly since?: number;
  /** Only the last this many of them. */
  readonly messages?: number;
  /** Subagents' tool calls too; left out otherwise. */
  readonly subagents?: boolean;
}

/**
 * The entries of a tab's conversation a read asks for: those after `since`,
 * the last `messages` of them; all when neither. Subagents' tool calls are
 * left out unless asked for; the others keep their places. A conversation
 * that ends before `since`, cleared or rewound since, is read from its
 * start. `end` is the i of its last entry, -1 when it has none.
 */
export function chatEntriesOf(
  chat: ChatTabState | undefined,
  query: ChatEntriesQuery = {},
): { entries: CliChatEntry[]; end: number } {
  if (!chat) return { entries: [], end: -1 };
  const all = allEntries(chat, query).entries;
  const end = all.length - 1;
  const since = query.since !== undefined && query.since <= end ? query.since : -1;
  const entries = all.filter(
    (entry) => entry.i > since && (query.subagents === true || !entry.parentToolUseId),
  );
  const last =
    query.messages === undefined
      ? entries
      : entries.slice(Math.max(0, entries.length - query.messages));
  return { entries: last, end };
}

/**
 * A tool call of a tab's conversation whole: `ref` is its entry's i (as a
 * read with the same `extras` counts it), or its id. Null when it names no
 * tool call.
 */
export function chatToolOf(
  chat: ChatTabState | undefined,
  ref: string,
  extras: ChatTabExtras = {},
): CliChatTool | null {
  if (!chat) return null;
  const { entries, tools } = allEntries(chat, extras);
  const entry = /^\d+$/.test(ref)
    ? entries.find((e) => e.i === Number(ref))
    : entries.find((e) => e.toolUseId === ref);
  const call = entry?.toolUseId ? tools[entry.toolUseId] : undefined;
  if (!entry || !call) return null;
  return {
    i: entry.i,
    toolUseId: call.id,
    name: call.displayName || call.name,
    status: call.status,
    input: call.input,
    ...(call.result ? { result: { text: call.result.text, isError: call.result.isError } } : {}),
    ...(call.parentToolUseId ? { parentToolUseId: call.parentToolUseId } : {}),
  };
}

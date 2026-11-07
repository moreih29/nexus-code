/**
 * A Claude or Codex tab's conversation as the nexus CLI tells it: where it
 * stands (chat state, chat wait), its messages (chat read) and a tool call
 * whole (chat tool). Pure.
 */

import type { CliChatEntry, CliChatInfo, CliChatTool } from "../../../shared/cli/ui";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { ChatItem, ChatModel, ToolCall } from "../chat/model";
import type { ChatTabState } from "../chat/store";
import { lastAnswer } from "../sessions/codex-state";
import { chatRowFacts, inputTarget } from "../sessions/rows";

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

/** The error a tab's last turn ended on, when it did. */
function turnError(model: ChatModel): string | undefined {
  if (!model.lastResult?.isError) return undefined;
  for (let i = model.items.length - 1; i >= 0; i--) {
    const item = model.items[i];
    if (item.kind === "user") return undefined;
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
  const at = since === undefined ? {} : { since };
  if (chat.phase === "failed" || chat.phase === "not-found") {
    const message =
      chat.phase === "not-found" ? `${agent} was not found where the workspace runs` : chat.error;
    return { agent, state: "error", ...(message ? { message } : {}), ...at };
  }
  const asked = model.permissions.length > 0 ? askedOf(model) : undefined;
  if (asked) return { agent, state: "asking", message: asked, ...at };
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
  }
}

/**
 * Every entry of a tab's conversation, its history before the program's log
 * included, each with its place: what the user and the agent said, the tools
 * the agent and its subagents ran, and what the app noted.
 */
function allEntries(chat: ChatTabState): {
  entries: CliChatEntry[];
  tools: ChatModel["tools"];
} {
  const { history, model } = chat;
  const items = history ? [...history.items, ...model.items] : model.items;
  const tools = history ? { ...history.tools, ...model.tools } : model.tools;
  const entries = items
    .flatMap((item) => entriesOfItem(item, tools))
    .map((entry, i) => ({ i, ...entry }));
  return { entries, tools };
}

export interface ChatEntriesQuery {
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
 * left out unless asked for; the others keep their places.
 */
export function chatEntriesOf(
  chat: ChatTabState | undefined,
  query: ChatEntriesQuery = {},
): CliChatEntry[] {
  if (!chat) return [];
  const since = query.since ?? -1;
  const entries = allEntries(chat).entries.filter(
    (entry) => entry.i > since && (query.subagents === true || !entry.parentToolUseId),
  );
  return query.messages === undefined
    ? entries
    : entries.slice(Math.max(0, entries.length - query.messages));
}

/**
 * A tool call of a tab's conversation whole: `ref` is its entry's i, or its
 * id. Null when it names no tool call.
 */
export function chatToolOf(chat: ChatTabState | undefined, ref: string): CliChatTool | null {
  if (!chat) return null;
  const { entries, tools } = allEntries(chat);
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

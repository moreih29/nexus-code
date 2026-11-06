/**
 * A Claude or Codex tab's conversation as the nexus CLI tells it: where it
 * stands (chat state, chat wait) and its last messages (chat read). Pure.
 */

import type { CliChatEntry, CliChatInfo } from "../../../shared/cli/ui";
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
  if (chat.phase === "failed" || chat.phase === "not-found") {
    const message =
      chat.phase === "not-found" ? `${agent} was not found where the workspace runs` : chat.error;
    return { agent, state: "error", ...(message ? { message } : {}) };
  }
  const asked = model.permissions.length > 0 ? askedOf(model) : undefined;
  if (asked) return { agent, state: "asking", message: asked };
  const answer = lastAnswer(model);
  const told = answer ? { message: answer } : {};
  if (unseen || model.running || chat.phase === "starting" || chat.phase === "held") {
    return { agent, state: "working", ...told };
  }
  const error = turnError(model);
  if (error) return { agent, state: "error", message: error };
  return { agent, state: "idle", ...told };
}

function toolEntry(call: ToolCall | undefined): CliChatEntry | null {
  if (!call || call.parentToolUseId) return null;
  const target = inputTarget(call.name, call.input);
  const failed =
    call.status === "error" ? " (failed)" : call.status === "denied" ? " (denied)" : "";
  return {
    role: "tool",
    text: `${call.displayName || call.name}${target ? ` ${target}` : ""}${failed}`,
  };
}

function entriesOfItem(item: ChatItem, tools: ChatModel["tools"]): CliChatEntry[] {
  switch (item.kind) {
    case "user": {
      const images = item.images.length;
      const attached = images === 0 ? "" : ` [${images} image${images === 1 ? "" : "s"}]`;
      return [{ role: "user", text: `${item.text.trim()}${attached}` }];
    }
    case "assistant": {
      const entries: CliChatEntry[] = [];
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
 * The last `messages` messages of a tab's conversation, its history before
 * the program's log included: what the user and the agent said, the tools
 * the agent ran on its main thread, and what the app noted.
 */
export function chatEntriesOf(chat: ChatTabState | undefined, messages: number): CliChatEntry[] {
  if (!chat) return [];
  const { history, model } = chat;
  const items = history ? [...history.items, ...model.items] : model.items;
  const tools = history ? { ...history.tools, ...model.tools } : model.tools;
  const entries = items.flatMap((item) => entriesOfItem(item, tools));
  return entries.slice(Math.max(0, entries.length - messages));
}

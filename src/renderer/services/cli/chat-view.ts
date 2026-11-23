import { type ChatPage, ITEM_KINDS, type ViewItem } from "../../../../packages/remote-protocol/src";
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
import { type ChatItem, type ChatModel, isWaiting, opensTurn, type ToolCall } from "../chat/model";
import { followsMessage } from "../chat/profile-moves";
import { relaySenderText, withRelayed } from "../chat/relayed";
import type { ChatTabState } from "../chat/store";

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

function waitingOf(model: ChatModel): CliChatWaiting | undefined {
  const wait = chatRowFacts(model).wait;
  if (!wait) return undefined;
  if (wait.kind === "permission") {
    return { kind: "permission", text: wait.target ? `${wait.tool} ${wait.target}` : wait.tool };
  }
  return { kind: wait.kind, text: wait.text };
}

const REQUEST_CHARS = 8_000;

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

function turnError(model: ChatModel): string | undefined {
  if (!model.lastResult?.isError) return undefined;
  for (let i = model.items.length - 1; i >= 0; i--) {
    const item = model.items[i];
    if (opensTurn(item)) return undefined;
    if (item.kind === "notice" && item.code === "error") return item.detail ?? "the turn failed";
  }
  return model.lastResult.subtype;
}

function sinceOf(model: ChatModel): number | undefined {
  if (model.running && model.turn?.startedAt !== undefined) return model.turn.startedAt;
  for (let i = model.items.length - 1; i >= 0; i--) {
    const at = model.items[i]?.at;
    if (at !== undefined) return at;
  }
  return undefined;
}

function goalOf(chat: ChatTabState): CliChatGoal | undefined {
  const goal = shownGoalOf(chat);
  if (!goal) return undefined;
  return {
    objective: goal.objective,
    status: goal.status,
    ...(goal.ended && goal.reason ? { reason: goal.reason } : {}),
  };
}

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
  if (
    unseen ||
    model.running ||
    chat.queue.some((item) => item.status === "sending") ||
    chat.phase === "starting" ||
    chat.phase === "held"
  ) {
    return { agent, state: "working", ...told, ...at };
  }
  const error = turnError(model);
  if (error) {
    const failure = model.lastResult?.failure?.kind;
    return { agent, state: "error", message: error, ...(failure ? { failure } : {}), ...at };
  }
  return { agent, state: "idle", ...told, ...at };
}

export function chatSubmissionInfo(
  agent: ChatAgent,
  chat: ChatTabState | undefined,
  submissionId: string,
): CliChatInfo {
  if (!chat) return { agent, state: "working" };
  const { model, history } = chat;
  const items = history ? [...history.items, ...model.items] : model.items;
  const accepted = items.findLast(
    (item) =>
      item.kind === "user" &&
      item.state === "taken" &&
      (agent === "claude" ? item.uuid === submissionId : item.key === `u-peer-${submissionId}`),
  );
  if (accepted?.kind === "user" && accepted.turnResult) {
    if (accepted.turnResult.error) {
      return { agent, state: "error", message: accepted.turnResult.error };
    }
    const turnId = accepted.turnId;
    const message = lastAnswer({
      ...model,
      items: items.filter(
        (item) =>
          item.kind === "assistant" &&
          turnId !== undefined &&
          (agent === "claude" ? item.turnId : item.messageId) === turnId,
      ),
    });
    return { agent, state: "idle", ...(message ? { message } : {}) };
  }
  if (
    accepted?.kind === "user" &&
    accepted.turnId !== undefined &&
    model.running &&
    accepted.turnId === model.turn?.id
  ) {
    return chatInfoOf(agent, chat, false);
  }
  if (chat.cancelledSubmissions?.includes(submissionId)) {
    return { agent, state: "error", message: "the held message was cancelled" };
  }
  const queued = chat.queue.find((item) => item.id === submissionId);
  if (queued?.status === "failed" || queued?.status === "unconfirmed") {
    return { agent, state: "error", message: queued.error ?? "could not confirm the submission" };
  }
  if (chat.phase === "failed" || chat.phase === "not-found") return chatInfoOf(agent, chat, false);
  return { agent, state: "working" };
}

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
      const unread = isWaiting(item) ? { status: "unread" } : {};
      return [{ role: "user", text: `${item.text.trim()}${attached}`, ...unread }];
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

export interface ChatTabExtras {
  readonly relayed?: readonly RelayedMessage[];
  readonly moves?: readonly { readonly after: string; readonly profile: string }[];
}

function allEntries(
  chat: ChatTabState,
  extras: ChatTabExtras = {},
): {
  entries: CliChatEntry[];
  tools: ChatModel["tools"];
  itemOf: number[];
} {
  const { history, model } = chat;
  const items = withRelayed(
    history ? [...history.items, ...model.items] : model.items,
    extras.relayed,
  );
  const tools = history ? { ...history.tools, ...model.tools } : model.tools;
  const movesAfter = new Map<ChatItem, string[]>();
  for (const move of extras.moves ?? []) {
    const item = items.findLast((i) => followsMessage(i, move.after));
    if (item) movesAfter.set(item, [...(movesAfter.get(item) ?? []), move.profile]);
  }
  const itemOf: number[] = [];
  const entries = items
    .flatMap((item, index): Entry[] => {
      const own = entriesOfItem(item, tools);
      const moved = movesAfter.get(item) ?? [];
      const its = [
        ...own,
        ...moved.map(
          (profile): Entry => ({
            role: "notice",
            text: `went on in profile ${JSON.stringify(profile)}`,
          }),
        ),
      ];
      itemOf.push(...its.map(() => index));
      return its;
    })
    .map((entry, i) => ({ i, ...entry }));
  return { entries, tools, itemOf };
}

export function chatItemIndexOf(
  chat: ChatTabState | undefined,
  i: number,
  extras: ChatTabExtras = {},
): number | null {
  if (!chat) return null;
  return allEntries(chat, extras).itemOf[i] ?? null;
}

export interface ChatEntriesQuery extends ChatTabExtras {
  readonly since?: number;
  readonly messages?: number;
  readonly subagents?: boolean;
}

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

export function pageEntriesOf(page: ChatPage, subagents = false): CliChatEntry[] {
  return page.items.flatMap((item, k) =>
    viewEntriesOf(item, page.tools)
      .filter((entry) => subagents || !entry.parentToolUseId)
      .map((entry) => ({ i: page.start + k, ...entry })),
  );
}

function viewEntriesOf(item: ViewItem, tools: ChatPage["tools"]): Entry[] {
  if (!ITEM_KINDS.has(item.kind)) return [];
  const asModel = tools as unknown as ChatModel["tools"];
  if (item.kind !== "received") return entriesOfItem(item as unknown as ChatItem, asModel);
  const received = item as Extract<ViewItem, { kind: "received" }>;
  const { replyTo, device } = received.from;
  const from = {
    ...received.from,
    ...(replyTo ? { workspaceId: replyTo.workspaceId, tabId: replyTo.tabId } : {}),
  };
  return entriesOfItem({ ...received, from } as unknown as ChatItem, asModel).map((entry) =>
    entry.from && device ? { ...entry, from: { ...entry.from, device } } : entry,
  );
}

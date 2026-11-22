/**
 * A Claude or Codex tab's conversation as another device of the account
 * reads it (chat.read): the items this app made of its program's log, its
 * history before that included, trimmed of what only this app uses, with
 * the tool calls, tasks and subagents' messages they name. Pure.
 */

import i18next from "i18next";
import {
  type ChatPage,
  type ChatStatus,
  type ImageRef,
  MAX_READ_ITEMS,
  MAX_RESULT_TEXT,
  type ViewAssistantItem,
  type ViewItem,
  type ViewPermission,
  type ViewTask,
  type ViewToolCall,
} from "../../../../packages/remote-protocol/src";
import type { RelayedMessage } from "../../../shared/chat/relay";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { LimitResume } from "../../../shared/types/layout";
import type { CodexModel, CodexRateLimits } from "../chat/codex/model";
import type {
  AssistantItem,
  ChatItem,
  ChatModel,
  ImageBlock,
  PermissionRequest,
  TaskInfo,
  ToolCall,
} from "../chat/model";
import { AGENT_TOOLS, jobOutputFile } from "../chat/panel";
import { scopesOf } from "../chat/permission-scopes";
import { withRelayed } from "../chat/relayed";
import type { ChatTabState } from "../chat/store";
import type { PeerSubmission } from "../chat/transport/submission";

/** How many items a read gives when it does not say. */
export const DEFAULT_READ_ITEMS = 200;

/** The most of a failure's text, or of a program's stderr, a status tells: its banner's details. */
const MAX_STATUS_TEXT = 8 * 1024;

/** The longest path a job's output file is told by (ViewTask.outputFile). */
const MAX_OUTPUT_PATH = 4096;

export interface ChatSource {
  agent: ChatAgent;
  title: string;
  chat: ChatTabState;
  /** The messages other agents sent it through the nexus command, told as theirs. */
  relayed?: readonly RelayedMessage[];
  peerSubmissions?: Readonly<Record<string, PeerSubmission>>;
  /** Its profile's plan usage as this app last heard it, as its composer's line shows it. */
  plan?: { claude?: Record<string, unknown>; codex?: CodexRateLimits };
  /**
   * Where the conversation went on in another profile: after the message
   * `after` (its id, as the tab keeps it), in the profile named `profile`.
   */
  moves?: readonly { after: string; profile: string; at: number }[];
  /** Going on after the plan's usage limit stopped it, as the tab keeps it. */
  limitResume?: LimitResume;
  /** What another device can do with it now, as the tab's own buttons do. */
  can?: {
    rewind: boolean;
    fork: boolean;
    background: boolean;
    now?: boolean;
    withdraw?: boolean;
    hurry?: boolean;
    moveNow?: boolean;
    mcp?: boolean;
    config?: boolean;
  };
}

/** The tab's whole conversation as it shows it: its history, then its program's log. */
export function conversationOf({ chat, relayed }: ChatSource): {
  items: ChatItem[];
  tools: Record<string, ToolCall>;
  agentItems: Record<string, AssistantItem[]>;
} {
  const { history, model } = chat;
  // Received messages are found by the keys the program gave (u-<id>), so
  // the history is keyed apart only after.
  const items = withRelayed(history ? [...history.items, ...model.items] : model.items, relayed);
  const fromHistory = history?.items.length ?? 0;
  return {
    items:
      fromHistory === 0
        ? items
        : items.map((item, i) => (i < fromHistory ? asHistory(item) : item)),
    tools: history ? { ...history.tools, ...model.tools } : model.tools,
    agentItems: history ? { ...history.agentItems, ...model.agentItems } : model.agentItems,
  };
}

/** History items as another device reads them, made once for each item. */
const historyItems = new WeakMap<ChatItem, ChatItem>();

/**
 * An item of the history keyed apart from the program's log: a resumed
 * program's log numbers its lines from 1 again, so its keys (a33) are the
 * history's too. The tab's own list keys them apart the same way.
 */
function asHistory(item: ChatItem): ChatItem {
  let keyed = historyItems.get(item);
  if (!keyed) {
    keyed = { ...item, key: `h-${item.key}` };
    historyItems.set(item, keyed);
  }
  return keyed;
}

/** How many bytes a base64 image holds. */
function imageRef({ mediaType, data }: ImageBlock): ImageRef {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { mediaType, bytes: Math.max(0, Math.floor((data.length * 3) / 4) - padding) };
}

export function viewItemOf(item: ChatItem): ViewItem {
  switch (item.kind) {
    case "user": {
      if (item.peerWritePending) return { kind: "pending-peer-write", key: item.key };
      const {
        uuid: _u,
        sentUuid: _s,
        turnId: _t,
        turnResult: _r,
        optimistic: _o,
        peerWritePending: _p,
        images,
        ...rest
      } = item;
      return { ...rest, images: images.map(imageRef) };
    }
    case "assistant": {
      const { uuid: _u, turnId: _t, ...rest } = item;
      return rest;
    }
    case "received": {
      const { uuid: _u, from, ...rest } = item;
      const { workspaceId, tabId, device, ...sender } = from;
      // Where the sender takes an answer: its tab, on its computer when it is another.
      const replyTo =
        workspaceId && tabId
          ? { ...(device ? { deviceId: device.id } : {}), workspaceId, tabId }
          : undefined;
      return {
        ...rest,
        from: { ...sender, ...(device ? { device } : {}), ...(replyTo ? { replyTo } : {}) },
      };
    }
    default:
      return item;
  }
}

export function viewAssistantOf(item: AssistantItem): ViewAssistantItem {
  const { uuid: _u, ...rest } = item;
  return rest;
}

/** A call as another device reads it, its result's text cut at `maxText` characters. */
export function viewToolOf(tool: ToolCall, maxText = MAX_RESULT_TEXT): ViewToolCall {
  const { partialInput: _p, result, ...rest } = tool;
  if (!result) return rest;
  const truncated = result.text.length > maxText;
  return {
    ...rest,
    result: {
      text: truncated ? result.text.slice(0, maxText) : result.text,
      isError: result.isError,
      ...(result.structured !== undefined
        ? { structured: structuredToSend(result.structured) }
        : {}),
      images: result.images.map(imageRef),
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

/**
 * A result's structured part as another device takes it: a file a Read gave whole (an image, a
 * PDF) without its bytes. No device shows them from there (an image comes by its ref), and an
 * image's alone could make its item too large to send, stopping the chat being read back past it.
 */
function structuredToSend(structured: unknown): unknown {
  if (!structured || typeof structured !== "object") return structured;
  const file = (structured as { file?: unknown }).file;
  if (!file || typeof file !== "object" || !("base64" in file)) return structured;
  const { base64: _bytes, ...rest } = file as Record<string, unknown>;
  return { ...structured, file: rest };
}

/**
 * A request as another device reads it: what "always allow" would add
 * named in this app's words, by the index chat.answer's `always` gives back.
 */
function viewPermissionOf(request: PermissionRequest): ViewPermission {
  const { suggestions, preview, ...rest } = request;
  const scopes = scopesOf(suggestions, (key, options) => String(i18next.t(key, options)));
  return {
    ...rest,
    ...(preview ? { preview: viewToolOf(preview) } : {}),
    ...(scopes.length > 0 ? { suggestions: scopes.map(({ label }) => ({ label })) } : {}),
  };
}

/** A task as the protocol tells it; `tools` give the call that started it, for its output file. */
export function viewTaskOf(task: TaskInfo, tools: Record<string, ToolCall> = {}): ViewTask {
  const outputFile = jobOutputFile(task, tools);
  return {
    taskId: task.taskId,
    type: task.type,
    description: task.description,
    status: task.status,
    ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.activity ? { activity: task.activity } : {}),
    ...(outputFile && outputFile.length <= MAX_OUTPUT_PATH ? { outputFile } : {}),
  };
}

export function chatStatusOf({ agent, title, chat }: ChatSource): ChatStatus {
  const model: ChatModel = chat.model;
  const version = chat.version ?? model.version;
  return {
    agent,
    title,
    ...(model.model ? { model: model.model } : {}),
    ...(model.effort ? { effort: model.effort } : {}),
    ...(model.permissionMode ? { permissionMode: model.permissionMode } : {}),
    running: model.running,
    ...(model.interrupting ? { interrupting: true } : {}),
    process: model.process,
    phase: chat.phase,
    ...(chat.phaseRevision !== undefined ? { phaseRevision: chat.phaseRevision } : {}),
    ...(chat.error ? { error: chat.error.slice(0, MAX_STATUS_TEXT) } : {}),
    ...(version ? { version } : {}),
    ...((model as Partial<CodexModel>).signedOut ? { signedOut: true } : {}),
    ...(model.exit
      ? {
          exit: {
            code: model.exit.code,
            ...(model.exit.signal ? { signal: model.exit.signal } : {}),
            ...(model.exit.stderrTail
              ? { stderrTail: model.exit.stderrTail.slice(-MAX_STATUS_TEXT) }
              : {}),
          },
        }
      : {}),
    turn: model.turn
      ? {
          ...(model.turn.startedAt !== undefined ? { startedAt: model.turn.startedAt } : {}),
          outputTokens: model.turn.outputTokens,
          ...(model.turn.thinkingTokens ? { thinkingTokens: model.turn.thinkingTokens } : {}),
          ...(model.turn.status ? { status: model.turn.status } : {}),
          ...(model.turn.retry ? { retry: { ...model.turn.retry } } : {}),
        }
      : null,
    streaming: model.streaming
      ? {
          messageId: model.streaming.messageId,
          blocks: Object.entries(model.streaming.blocks)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([, block]) => ({
              type: block.type,
              text: block.text,
              ...(block.toolUseId ? { toolUseId: block.toolUseId } : {}),
            })),
        }
      : null,
    permissions: model.permissions.map(viewPermissionOf),
  };
}

/** The tool calls the items name, with those that run under them, and their subagents' messages. */
export function namedBy(
  items: readonly ChatItem[],
  tools: Record<string, ToolCall>,
  agentItems: Record<string, AssistantItem[]>,
  includeNativeAgents = false,
): { tools: Set<string>; agents: Set<string> } {
  const named = new Set<string>();
  const agents = new Set<string>();
  const visit = (blocks: AssistantItem["blocks"]) => {
    for (const block of blocks) {
      if (block.type !== "tool" || named.has(block.toolUseId)) continue;
      named.add(block.toolUseId);
      const sub = agentItems[block.toolUseId];
      if (sub) {
        agents.add(block.toolUseId);
        for (const item of sub) visit(item.blocks);
      }
    }
  };
  for (const item of items) if (item.kind === "assistant") visit(item.blocks);
  // Codex can discover a child independently of the parent messages in this page.
  if (includeNativeAgents) {
    for (const [id, messages] of Object.entries(agentItems)) {
      if (agents.has(id)) continue;
      agents.add(id);
      for (const item of messages) visit(item.blocks);
    }
  }
  // A subagent's calls that its messages do not name (still streaming in) run under a named one.
  for (const tool of Object.values(tools)) {
    if (tool.parentToolUseId && named.has(tool.parentToolUseId)) named.add(tool.id);
  }
  return { tools: named, agents };
}

/** The tasks a page tells: those its items name, and those still running. */
function tasksOf(
  model: ChatModel,
  items: readonly ChatItem[],
  tools: ReadonlySet<string>,
): TaskInfo[] {
  const ended = new Set(items.flatMap((i) => (i.kind === "task_end" ? [i.taskId] : [])));
  return Object.values(model.tasks).filter(
    (task) =>
      task.status === "running" ||
      ended.has(task.taskId) ||
      (task.toolUseId !== undefined && tools.has(task.toolUseId)),
  );
}

/**
 * The conversation's items from `start` to `end` as the tab holds them,
 * with the calls, tasks and subagents' messages they name: what a page
 * tells, before it is trimmed for another device.
 */
export interface ChatWindow {
  start: number;
  total: number;
  items: readonly ChatItem[];
  tools: ReadonlyMap<string, ToolCall>;
  tasks: ReadonlyMap<string, TaskInfo>;
  agents: ReadonlyMap<string, AssistantItem[]>;
}

/** Correlation for this window's user rows. Changed messages retain stable objects for watch diffs. */
const submissionsInView = new WeakMap<ChatItem, { submission: PeerSubmission; view: ChatItem }>();

function withPeerSubmission(item: ChatItem, source: ChatSource): ChatItem {
  if (item.kind !== "user") return item;
  const id =
    source.agent === "codex"
      ? /^(?:h-)?u-peer-(.+)$/.exec(item.key)?.[1]
      : (item.sentUuid ?? item.uuid);
  const submission = id ? (source.peerSubmissions ?? source.chat.peerSubmissions)?.[id] : undefined;
  if (!submission) return item;
  const cached = submissionsInView.get(item);
  if (cached?.submission === submission) return cached.view;
  const { clientNonce, clientDeviceId } = submission;
  const view = {
    ...item,
    clientNonce,
    clientDeviceId,
    ...(source.agent === "claude" && item.state === "sent" && !submission.written
      ? { peerWritePending: true }
      : {}),
  };
  submissionsInView.set(item, { submission, view });
  return view;
}

export function chatWindowOf(source: ChatSource, start: number, end?: number): ChatWindow {
  return windowOf(source, conversationOf(source), start, end);
}

function windowOf(
  source: ChatSource,
  { items, tools, agentItems }: ReturnType<typeof conversationOf>,
  start: number,
  end?: number,
): ChatWindow {
  const total = items.length;
  const last = Math.min(end ?? total, total);
  const first = Math.min(start, last);
  const window = items.slice(first, last);
  const shown =
    (source.peerSubmissions ?? source.chat.peerSubmissions)
      ? window.map((item) => withPeerSubmission(item, source))
      : window;
  const named = namedBy(shown, tools, agentItems, source.agent === "codex" && last === total);
  // The reply being written names its calls before any item does.
  if (last === total) {
    for (const block of Object.values(source.chat.model.streaming?.blocks ?? {})) {
      if (block.toolUseId) named.tools.add(block.toolUseId);
    }
  }
  return {
    start: first,
    total,
    items: shown,
    tools: new Map(
      [...named.tools].flatMap((id) => {
        const tool = tools[id];
        return tool ? [[id, tool] as const] : [];
      }),
    ),
    tasks: new Map(
      tasksOf(source.chat.model, shown, named.tools).map((task) => [task.taskId, task] as const),
    ),
    agents: new Map([...named.agents].map((id) => [id, agentItems[id] ?? []] as const)),
  };
}

/** The chat's last `limit` items, or those before `before`, as chat.read gives them. */
export function chatPageOf(
  source: ChatSource,
  { before, limit }: { before?: number; limit?: number } = {},
): ChatPage {
  const conversation = conversationOf(source);
  const total = conversation.items.length;
  const end = Math.min(before ?? total, total);
  const count = Math.min(limit ?? DEFAULT_READ_ITEMS, MAX_READ_ITEMS);
  const window = windowOf(source, conversation, Math.max(0, end - count), end);
  return {
    status: chatStatusOf(source),
    start: window.start,
    total: window.total,
    items: window.items.map(viewItemOf),
    tools: Object.fromEntries([...window.tools].map(([id, tool]) => [id, viewToolOf(tool)])),
    tasks: Object.fromEntries(
      [...window.tasks].map(([id, task]) => [id, viewTaskOf(task, conversation.tools)]),
    ),
    agentItems: Object.fromEntries(
      [...window.agents].map(([id, items]) => [id, items.map(viewAssistantOf)]),
    ),
  };
}

/** How long a page read waits for the subagents it names to be read, before it goes without them. */
export const SUBAGENTS_WAIT_MS = 3_000;

/**
 * The subagents a page names that it has no messages of: a conversation
 * read back from its transcript has none, as Claude Code keeps a
 * subagent's messages in a file of its own.
 */
export function unreadSubagentsOf(page: ChatPage): string[] {
  return Object.entries(page.tools).flatMap(([id, tool]) =>
    tool.parentToolUseId === null && AGENT_TOOLS.has(tool.name) && !page.agentItems[id] ? [id] : [],
  );
}

/**
 * A page with the messages of the subagents it names: `read` again once
 * `load` has read those it has none of, or once `waitMs` passed, as another
 * device opens a subagent that ended from the page it read. One that names
 * none it lacks is read once.
 */
export async function pageWithSubagents(
  read: () => ChatPage,
  load: (toolUseIds: string[]) => Promise<unknown>,
  waitMs = SUBAGENTS_WAIT_MS,
): Promise<ChatPage> {
  const page = read();
  const unread = unreadSubagentsOf(page);
  if (unread.length === 0) return page;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    load(unread).catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
  return read();
}

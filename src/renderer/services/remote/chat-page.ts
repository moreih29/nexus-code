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
import type {
  AssistantItem,
  ChatItem,
  ChatModel,
  ImageBlock,
  PermissionRequest,
  TaskInfo,
  ToolCall,
} from "../chat/model";
import { scopesOf } from "../chat/permission-scopes";
import { withRelayed } from "../chat/relayed";
import type { ChatTabState } from "../chat/store";

/** How many items a read gives when it does not say. */
export const DEFAULT_READ_ITEMS = 200;

export interface ChatSource {
  agent: ChatAgent;
  title: string;
  chat: ChatTabState;
  /** The messages other agents sent it through the nexus command, told as theirs. */
  relayed?: readonly RelayedMessage[];
}

/** The tab's whole conversation as it shows it: its history, then its program's log. */
export function conversationOf({ chat, relayed }: ChatSource): {
  items: ChatItem[];
  tools: Record<string, ToolCall>;
  agentItems: Record<string, AssistantItem[]>;
} {
  const { history, model } = chat;
  return {
    items: withRelayed(history ? [...history.items, ...model.items] : model.items, relayed),
    tools: history ? { ...history.tools, ...model.tools } : model.tools,
    agentItems: history ? { ...history.agentItems, ...model.agentItems } : model.agentItems,
  };
}

/** How many bytes a base64 image holds. */
function imageRef({ mediaType, data }: ImageBlock): ImageRef {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { mediaType, bytes: Math.max(0, Math.floor((data.length * 3) / 4) - padding) };
}

export function viewItemOf(item: ChatItem): ViewItem {
  switch (item.kind) {
    case "user": {
      const { uuid: _u, sentUuid: _s, turnId: _t, images, ...rest } = item;
      return { ...rest, images: images.map(imageRef) };
    }
    case "assistant": {
      const { uuid: _u, ...rest } = item;
      return rest;
    }
    case "received": {
      const { uuid: _u, from, ...rest } = item;
      const { workspaceId, tabId, hops: _h, device, ...sender } = from;
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
      ...(result.structured !== undefined ? { structured: result.structured } : {}),
      images: result.images.map(imageRef),
      ...(truncated ? { truncated: true } : {}),
    },
  };
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

export function viewTaskOf(task: TaskInfo): ViewTask {
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
  };
}

export function chatStatusOf({ agent, title, chat }: ChatSource): ChatStatus {
  const model: ChatModel = chat.model;
  return {
    agent,
    title,
    ...(model.model ? { model: model.model } : {}),
    ...(model.effort ? { effort: model.effort } : {}),
    ...(model.permissionMode ? { permissionMode: model.permissionMode } : {}),
    running: model.running,
    process: model.process,
    turn: model.turn
      ? {
          ...(model.turn.startedAt !== undefined ? { startedAt: model.turn.startedAt } : {}),
          outputTokens: model.turn.outputTokens,
          ...(model.turn.status ? { status: model.turn.status } : {}),
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

export function chatWindowOf(source: ChatSource, start: number, end?: number): ChatWindow {
  const { items, tools, agentItems } = conversationOf(source);
  const total = items.length;
  const last = Math.min(end ?? total, total);
  const first = Math.min(start, last);
  const shown = items.slice(first, last);
  const named = namedBy(shown, tools, agentItems);
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
  const total = conversationOf(source).items.length;
  const end = Math.min(before ?? total, total);
  const count = Math.min(limit ?? DEFAULT_READ_ITEMS, MAX_READ_ITEMS);
  const window = chatWindowOf(source, Math.max(0, end - count), end);
  return {
    status: chatStatusOf(source),
    start: window.start,
    total: window.total,
    items: window.items.map(viewItemOf),
    tools: Object.fromEntries([...window.tools].map(([id, tool]) => [id, viewToolOf(tool)])),
    tasks: Object.fromEntries([...window.tasks].map(([id, task]) => [id, viewTaskOf(task)])),
    agentItems: Object.fromEntries(
      [...window.agents].map(([id, items]) => [id, items.map(viewAssistantOf)]),
    ),
  };
}

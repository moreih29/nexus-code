/**
 * Another device's chat page (chat.read) as this app's chat model, so its
 * message list draws a remote conversation as it draws its own. What the
 * page leaves out stays empty: an image's bytes stay on that device. Pure.
 */

import type {
  ChatPage,
  ChatUpdate,
  ViewAssistantItem,
  ViewItem,
} from "../../../../packages/remote-protocol/src";
import {
  type AssistantItem,
  type ChatItem,
  type ChatModel,
  emptyModel,
  type NoticeCode,
  type StreamingBlock,
  type TaskInfo,
  type ToolCall,
} from "../chat/model";

/** An item this version draws; one of a kind it does not know is left out. */
function itemOf(item: ViewItem): ChatItem | null {
  switch (item.kind) {
    case "user":
      if (!("images" in item)) return null;
      // The bytes are not sent: an image shows as missing rather than broken.
      return { ...item, kind: "user", images: [] } as ChatItem;
    case "assistant":
    case "received":
    case "task_end":
    case "shell":
      return item as ChatItem;
    case "notice":
      return { ...item, code: item.code as NoticeCode } as ChatItem;
    default:
      return null;
  }
}

function toolOf(tool: ChatPage["tools"][string]): ToolCall {
  const { result, status, input, ...rest } = tool;
  return {
    ...rest,
    input,
    status: status as ToolCall["status"],
    ...(result
      ? {
          result: {
            text: result.truncated ? `${result.text}…` : result.text,
            isError: result.isError,
            ...(result.structured !== undefined ? { structured: result.structured } : {}),
            images: [],
          },
        }
      : {}),
  };
}

export function modelOfPage(page: ChatPage): ChatModel {
  const { status } = page;
  const streaming: Record<number, StreamingBlock> = {};
  for (const [index, block] of (status.streaming?.blocks ?? []).entries()) {
    streaming[index] = block;
  }
  return {
    ...emptyModel(),
    items: page.items.flatMap((item) => itemOf(item) ?? []),
    tools: Object.fromEntries(Object.entries(page.tools).map(([id, t]) => [id, toolOf(t)])),
    permissions: status.permissions.map(({ preview, suggestions, ...p }) => ({
      ...p,
      // In the serving computer's words; chat.answer keeps them by index.
      suggestions: (suggestions ?? []).map(({ label }, index) => ({
        type: "remote",
        label,
        index,
      })),
      ...(preview ? { preview: toolOf(preview) } : {}),
    })),
    streaming: status.streaming
      ? { messageId: status.streaming.messageId, blocks: streaming }
      : null,
    ...(status.model ? { model: status.model } : {}),
    ...(status.effort ? { effort: status.effort } : {}),
    ...(status.permissionMode ? { permissionMode: status.permissionMode } : {}),
    running: status.running,
    process: status.process,
    turn: status.turn
      ? {
          ...(status.turn.startedAt !== undefined ? { startedAt: status.turn.startedAt } : {}),
          outputTokens: status.turn.outputTokens,
          thinkingTokens: 0,
          ...(status.turn.status ? { status: status.turn.status } : {}),
        }
      : null,
    tasks: page.tasks as Record<string, TaskInfo>,
    agentItems: page.agentItems as Record<string, AssistantItem[]>,
  };
}

/**
 * A watched chat's page with an update put in: items at their index (one
 * before the page's start moves the start back), the list cut at `total`,
 * text appended to assistant items, the status replaced when sent (the
 * streaming message kept when it comes without one) and text appended to
 * that message, calls, tasks and subagents' messages put by id. Null when
 * an append finds nothing to go on: something was missed, and the watch
 * starts again. Pure.
 */
export function applyUpdate(page: ChatPage, update: ChatUpdate): ChatPage | null {
  const lowest = update.items.reduce((low, { index }) => Math.min(low, index), page.start);
  const start = Math.min(lowest, update.total);
  const length = Math.max(0, update.total - start);
  const items: (ViewItem | undefined)[] = new Array(length);
  for (const [i, item] of page.items.entries()) {
    const at = page.start + i - start;
    if (at >= 0 && at < length) items[at] = item;
  }
  for (const { index, item } of update.items) {
    const at = index - start;
    if (at >= 0 && at < length) items[at] = item;
  }
  for (const { index, block, text } of update.appends ?? []) {
    const at = index - start;
    // Before the page: not the watcher's to show.
    if (at < 0) continue;
    const item = items[at];
    if (item?.kind !== "assistant") return null;
    const assistant = item as ViewAssistantItem;
    const old = assistant.blocks[block];
    if (!old || old.type === "tool") return null;
    const blocks = [...assistant.blocks];
    blocks[block] = { ...old, text: old.text + text };
    items[at] = { ...assistant, blocks };
  }
  // A place no update filled, before the old start, has nothing to show.
  const filled = items.findIndex((item) => item !== undefined);
  const from = filled === -1 ? length : filled;
  const status = statusOf(page.status, update);
  if (!status) return null;
  return {
    status,
    start: start + from,
    total: update.total,
    items: items.slice(from).filter((item): item is ViewItem => item !== undefined),
    tools: { ...page.tools, ...update.tools },
    tasks: { ...page.tasks, ...update.tasks },
    agentItems: { ...page.agentItems, ...update.agentItems },
  };
}

/** The status after an update, with its streaming message's appends; null when one has nowhere to go. */
function statusOf(was: ChatPage["status"], update: ChatUpdate): ChatPage["status"] | null {
  const sent = update.status;
  const status: ChatPage["status"] = sent
    ? { ...sent, streaming: sent.streaming === undefined ? was.streaming : sent.streaming }
    : was;
  const appends = update.streamAppends ?? [];
  if (appends.length === 0) return status;
  const streaming = status.streaming;
  if (!streaming) return null;
  const blocks = [...streaming.blocks];
  for (const { block, text } of appends) {
    const old = blocks[block];
    if (!old) return null;
    blocks[block] = { ...old, text: old.text + text };
  }
  return { ...status, streaming: { ...streaming, blocks } };
}

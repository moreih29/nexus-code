/**
 * Another device's chat page (chat.read) as this app's chat model, so its
 * message list draws a remote conversation as it draws its own. What the
 * page leaves out stays empty: an image's bytes stay on that device. Pure.
 */

import type { ChatPage, ViewItem } from "../../../../packages/remote-protocol/src";
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
    permissions: status.permissions.map(({ preview, ...p }) => ({
      ...p,
      suggestions: [],
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

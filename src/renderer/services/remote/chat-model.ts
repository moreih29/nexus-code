import type { z } from "zod";
import type {
  ChatPage,
  ChatUpdate,
  ImageRef,
  ViewAssistantItem,
  ViewItem,
} from "../../../../packages/remote-protocol/src";
import type { ReceivedItemSchema } from "../../../../packages/remote-protocol/src/view";
import type { RetryReason } from "../chat/api-errors";
import {
  type AssistantItem,
  type ChatItem,
  type ChatModel,
  emptyModel,
  type MessageSource,
  type NoticeCode,
  type StreamingBlock,
  type TaskInfo,
  type ToolCall,
  type TurnRetry,
} from "../chat/model";

export interface PageSource {
  deviceId: string;
  deviceName: string;
  selfId?: string;
}

type ViewSender = z.infer<typeof ReceivedItemSchema>["from"];

const RETRY_REASONS: ReadonlySet<string> = new Set<RetryReason>([
  "rate_limit",
  "overloaded",
  "server",
  "connection",
  "auth",
  "other",
]);

function retryOf(retry: {
  attempt: number;
  maxRetries?: number;
  delayMs?: number;
  at?: number;
  status?: number;
  reason?: string;
}): TurnRetry {
  const { reason, ...rest } = retry;
  if (reason === undefined) return rest;
  return { ...rest, reason: RETRY_REASONS.has(reason) ? (reason as RetryReason) : "other" };
}

export function senderOf(from: ViewSender, source?: PageSource): MessageSource {
  const { replyTo, device, ...rest } = from;
  const sender: MessageSource = { ...rest };
  if (replyTo) {
    sender.workspaceId = replyTo.workspaceId;
    sender.tabId = replyTo.tabId;
  }
  if (!source) {
    if (device) sender.device = device;
    return sender;
  }
  const id = replyTo?.deviceId ?? device?.id ?? source.deviceId;
  if (id === source.selfId) return sender;
  sender.device =
    device && device.id === id
      ? device
      : { id, name: id === source.deviceId ? source.deviceName : (device?.name ?? id) };
  return sender;
}

function itemOf(item: ViewItem, source?: PageSource): ChatItem | null {
  switch (item.kind) {
    case "user":
      if (!("images" in item)) return null;
      return {
        ...item,
        kind: "user",
        ...(item.state === "taken" ? { uuid: item.key } : {}),
        ...(item.state === "sent" && item.queued ? { sentUuid: item.key } : {}),
        images: (item.images as readonly ImageRef[]).map(({ mediaType }, index) => ({
          mediaType,
          data: "",
          remote: { kind: "user", itemKey: item.key, index },
        })),
      } as ChatItem;
    case "received":
      return {
        ...item,
        uuid: item.key,
        from: senderOf(item.from as ViewSender, source),
      } as ChatItem;
    case "assistant":
      return { ...item, uuid: item.key } as ChatItem;
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
  const images = (result?.images ?? []).map(({ mediaType }, index) => ({
    mediaType,
    data: "",
    remote: { kind: "tool" as const, toolUseId: tool.id, index },
  }));
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
            images,
          },
        }
      : {}),
  };
}

export function modelOfPage(page: ChatPage, source?: PageSource): ChatModel {
  const { status } = page;
  const streaming: Record<number, StreamingBlock> = {};
  for (const [index, block] of (status.streaming?.blocks ?? []).entries()) {
    streaming[index] = block;
  }
  return {
    ...emptyModel(),
    items: page.items.flatMap((item) => itemOf(item, source) ?? []),
    tools: Object.fromEntries(Object.entries(page.tools).map(([id, t]) => [id, toolOf(t)])),
    permissions: status.permissions.map(({ preview, suggestions, ...p }) => ({
      ...p,
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
    ...(status.interrupting ? { interrupting: true } : {}),
    process: status.process,
    turn: status.turn
      ? {
          ...(status.turn.startedAt !== undefined ? { startedAt: status.turn.startedAt } : {}),
          outputTokens: status.turn.outputTokens,
          thinkingTokens: status.turn.thinkingTokens ?? 0,
          ...(status.turn.status ? { status: status.turn.status } : {}),
          ...(status.turn.retry ? { retry: retryOf(status.turn.retry) } : {}),
        }
      : null,
    ...(status.failure
      ? {
          lastResult: {
            subtype: "error",
            isError: true,
            failure: {
              kind: status.failure.kind,
              ...(status.failure.status !== undefined ? { status: status.failure.status } : {}),
            },
            ...(status.failure.at !== undefined ? { at: status.failure.at } : {}),
          },
        }
      : {}),
    tasks: page.tasks as Record<string, TaskInfo>,
    agentItems: page.agentItems as Record<string, AssistantItem[]>,
  };
}

export function watchMissedUpdate(current: ChatPage, fresh: ChatPage): boolean {
  if (current.total !== fresh.total || !sameWireValue(current.status, fresh.status)) return true;
  for (const [index, item] of fresh.items.entries()) {
    const at = fresh.start + index - current.start;
    if (at >= 0 && !sameWireValue(current.items[at], item)) return true;
  }
  return (
    Object.entries(fresh.tools).some(([id, tool]) => {
      const existing = current.tools[id];
      return existing ? !sameWatchedTool(existing, tool) : tool.parentToolUseId === null;
    }) ||
    Object.entries(fresh.tasks).some(([id, task]) => !sameWireValue(current.tasks[id], task)) ||
    Object.entries(fresh.agentItems).some(
      ([id, items]) =>
        current.agentItems[id] !== undefined && !sameWireValue(current.agentItems[id], items),
    )
  );
}

function sameWireValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => sameWireValue(entry, b[index]))
    );
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return (
    keys.length === Object.values(right).filter((value) => value !== undefined).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameWireValue(left[key], right[key]))
  );
}

function sameWatchedTool(a: ChatPage["tools"][string], b: ChatPage["tools"][string]): boolean {
  const { result: aResult, ...aTool } = a;
  const { result: bResult, ...bTool } = b;
  if (!sameWireValue(aTool, bTool)) return false;
  if (!aResult || !bResult) return aResult === bResult;
  const { text: aText, truncated: aCut, structured: aData, ...aFacts } = aResult;
  const { text: bText, truncated: bCut, structured: bData, ...bFacts } = bResult;
  const sameText =
    aText === bText || (aCut && bText.startsWith(aText)) || (bCut && aText.startsWith(bText));
  const comparableData = (aData !== undefined || !aCut) && (bData !== undefined || !bCut);
  return (
    !!sameText && sameWireValue(aFacts, bFacts) && (!comparableData || sameWireValue(aData, bData))
  );
}

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

export function withEarlier<P extends ChatPage>(page: P, earlier: ChatPage): P {
  if (earlier.start + earlier.items.length !== page.start) return page;
  return {
    ...page,
    start: earlier.start,
    items: [...earlier.items, ...page.items],
    tools: { ...earlier.tools, ...page.tools },
    tasks: { ...earlier.tasks, ...page.tasks },
    agentItems: { ...earlier.agentItems, ...page.agentItems },
  };
}

export function keepEarlier<P extends ChatPage>(old: ChatPage, fresh: P): P {
  if (old.start >= fresh.start) return fresh;
  const at = fresh.start - old.start;
  const first = fresh.items[0];
  if (at > old.items.length) return fresh;
  const there = old.items[at];
  const agrees = first ? there === undefined || there.key === first.key : at === old.items.length;
  if (!agrees) return fresh;
  return withEarlier(fresh, { ...old, items: old.items.slice(0, at) });
}

import type { ClaudeGoal } from "../goal";
import {
  type AssistantItem,
  type ChatLine,
  type ChatModel,
  emptyModel,
  type ToolCall,
} from "../model";
import {
  applyLines,
  applyTranscriptLines,
  isCommandOutput,
  SENDER_KINDS,
  type TranscriptLine,
  typedCommand,
} from "./stream-model";

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

export function transcriptLines(
  entries: readonly unknown[],
  positions?: readonly number[],
  liveCompacted = false,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let pending: { at: number; line: TranscriptLine; command: boolean } | undefined;
  const settle = () => {
    if (pending) lines.splice(pending.at, 0, pending.line);
    pending = undefined;
  };
  for (const [index, raw] of entries.entries()) {
    const seq = (positions ? positions[index] : index) + 1;
    const entry = rec(raw);
    if (!entry || entry.isSidechain === true) continue;
    if (pending) {
      const text = entry.type === "user" ? textOf(rec(entry.message)?.content) : "";
      const output = entry.type === "user" && isCommandOutput(text);
      if (output && pending.command) {
        lines.push({ ...pending.line, seq });
        pending = undefined;
        continue;
      }
      if (entry.type === "user" && typedCommand(text) !== null) pending.command = true;
      else if (
        !output &&
        !(entry.type === "user" && entry.isCompactSummary === true) &&
        !(entry.isMeta === true && text.startsWith("<local-command-caveat>"))
      ) {
        settle();
      }
    }
    const queued = queuedLine(entry, seq);
    if (queued) {
      lines.push(queued);
      continue;
    }
    const kind = rec(entry.origin)?.kind;
    const origin = typeof kind === "string" ? kind : undefined;
    const told =
      origin !== undefined && (SENDER_KINDS.has(origin) || origin === "task-notification");
    if (entry.isMeta === true && !told) continue;
    if (entry.type === "user" && entry.promptSource === "system" && !told) continue;
    if (entry.type === "user" && entry.isCompactSummary === true) continue;
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      settle();
      pending = {
        at: lines.length,
        command: false,
        line: {
          seq,
          dir: "out",
          replay: true,
          message: { type: "system", subtype: "compact_boundary", timestamp: entry.timestamp },
        },
      };
      continue;
    }
    const goal = goalLine(entry, seq);
    if (goal) {
      lines.push(goal);
      continue;
    }
    let message = rec(entry.message);
    if (!message) continue;
    if (entry.type === "user") {
      const text = textOf(message.content);
      if (isCommandOutput(text)) continue;
      const command = typedCommand(text);
      if (command === "/clear") continue;
      if (command !== null) message = { ...message, content: command };
    }
    if (entry.type === "assistant") {
      lines.push({
        seq,
        dir: "out",
        replay: true,
        message: {
          type: "assistant",
          message,
          uuid: entry.uuid,
          timestamp: entry.timestamp,
          ...(entry.isApiErrorMessage === true
            ? {
                is_api_error_message: true,
                error: entry.error,
                api_error: entry.apiError,
                api_error_status: entry.apiErrorStatus,
                api_error_params: entry.apiErrorParams,
              }
            : {}),
        },
      });
    } else if (entry.type === "user") {
      const content = message.content;
      const results = Array.isArray(content) && content.some((b) => rec(b)?.type === "tool_result");
      lines.push({
        seq,
        dir: "out",
        replay: true,
        message: results
          ? {
              type: "user",
              message,
              uuid: entry.uuid,
              timestamp: entry.timestamp,
              tool_use_result: entry.toolUseResult,
            }
          : isInterrupt(content)
            ? { type: "user", message, uuid: entry.uuid, timestamp: entry.timestamp }
            : {
                type: "user",
                message,
                uuid: entry.uuid,
                timestamp: entry.timestamp,
                isReplay: true,
                isSynthetic: entry.isMeta === true,
                origin: entry.origin,
                fromTranscript: true,
              },
      });
    }
  }
  if (liveCompacted) pending = undefined;
  else settle();
  return lines;
}

function queuedLine(entry: Rec, seq: number): TranscriptLine | null {
  if (entry.type !== "attachment") return null;
  const attachment = rec(entry.attachment);
  if (attachment?.type !== "queued_command") return null;
  const mode = attachment.commandMode;
  if (mode !== undefined && mode !== "prompt" && mode !== "task-notification") return null;
  const prompt = attachment.prompt;
  if (typeof prompt !== "string" && !Array.isArray(prompt)) return null;
  return {
    seq,
    dir: "out",
    replay: true,
    message: {
      type: "user",
      message: { role: "user", content: prompt },
      uuid: queuedUuid(entry),
      timestamp: attachment.timestamp ?? entry.timestamp,
      isReplay: true,
      isSynthetic: attachment.isMeta === true,
      origin: attachment.origin ?? (mode === "task-notification" ? { kind: mode } : undefined),
      fromTranscript: true,
      midTurn: attachment.hostsOwnTurn !== true,
    },
  };
}

function queuedUuid(entry: Rec): unknown {
  const attachment = rec(entry.attachment);
  return attachment?.type === "queued_command" && typeof attachment.source_uuid === "string"
    ? attachment.source_uuid
    : entry.uuid;
}

function goalLine(entry: Rec, seq: number): TranscriptLine | null {
  if (entry.type === "attachment") {
    const attachment = rec(entry.attachment);
    if (attachment?.type !== "goal_status" || attachment.sentinel === true) return null;
    return {
      seq,
      dir: "out",
      replay: true,
      message: { ...attachment, type: "goal_status", timestamp: entry.timestamp },
    };
  }
  if (entry.type !== "system" || entry.subtype !== "local_command") return null;
  const content = typeof entry.content === "string" ? entry.content.trim() : "";
  const output = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(content)?.[1];
  if (!output || !/^Goal (set|cleared): /.test(output.trim())) return null;
  return {
    seq,
    dir: "out",
    replay: true,
    message: {
      type: "assistant",
      local_command_run: { command: "goal" },
      message: {
        id: `goal-${String(entry.uuid)}`,
        content: [{ type: "text", text: output.trim() }],
      },
      uuid: entry.uuid,
      timestamp: entry.timestamp,
    },
  };
}

export function subagentLines(entries: readonly unknown[], toolUseId: string): ChatLine[] {
  const lines: ChatLine[] = [];
  for (const raw of entries) {
    const entry = rec(raw);
    const message = rec(entry?.message);
    if (!entry || !message) continue;
    const base = { uuid: entry.uuid, timestamp: entry.timestamp, parent_tool_use_id: toolUseId };
    if (entry.type === "assistant") {
      lines.push({
        seq: lines.length + 1,
        dir: "out",
        replay: true,
        message: { type: "assistant", message, ...base },
      });
    } else if (
      entry.type === "user" &&
      Array.isArray(message.content) &&
      message.content.some((block) => rec(block)?.type === "tool_result")
    ) {
      lines.push({
        seq: lines.length + 1,
        dir: "out",
        replay: true,
        message: { type: "user", message, tool_use_result: entry.toolUseResult, ...base },
      });
    }
  }
  return lines;
}

export interface SubagentLog {
  items: AssistantItem[];
  tools: Record<string, ToolCall>;
}

export function subagentLog(entries: readonly unknown[], toolUseId: string): SubagentLog {
  const model = applyLines(emptyModel(), subagentLines(entries, toolUseId));
  return { items: model.agentItems[toolUseId] ?? [], tools: model.tools };
}

export function withSubagentLog(
  history: ChatModel | null,
  toolUseId: string,
  log: SubagentLog,
): ChatModel {
  const base = history ?? emptyModel();
  return {
    ...base,
    agentItems: { ...base.agentItems, [toolUseId]: log.items },
    tools: { ...log.tools, ...base.tools },
  };
}

export function subagentIdOf(tool: ToolCall | undefined): string | undefined {
  const structured = rec(tool?.result?.structured);
  const id = structured?.agentId ?? structured?.agent_id;
  return typeof id === "string" && id ? id : undefined;
}

export function transcriptGoal(entries: readonly unknown[]): ClaudeGoal | null | undefined {
  return applyTranscriptLines(transcriptLines(entries)).goal;
}

function textOf(content: unknown): string {
  const first = Array.isArray(content) ? rec(content[0]) : null;
  return typeof content === "string" ? content : typeof first?.text === "string" ? first.text : "";
}

function isInterrupt(content: unknown): boolean {
  return textOf(content).startsWith("[Request interrupted");
}

export interface HistoryCut {
  upTo?: string;
  before?: ReadonlySet<string>;
}

export function cutEntries(entries: readonly unknown[], cut: HistoryCut = {}): unknown[] {
  const kept: unknown[] = [];
  for (const raw of entries) {
    const entry = rec(raw);
    const uuid = entry ? queuedUuid(entry) : undefined;
    if (cut.before && typeof uuid === "string" && cut.before.has(uuid)) break;
    kept.push(raw);
    if (cut.upTo !== undefined && uuid === cut.upTo) break;
  }
  return kept;
}

export function historyModel(
  entries: readonly unknown[],
  cut?: HistoryCut,
  positions?: readonly number[],
  liveCompacted = false,
): ChatModel {
  const model = applyTranscriptLines(
    cut
      ? transcriptLines(cutEntries(entries, cut), undefined, liveCompacted)
      : transcriptLines(entries, positions, liveCompacted),
  );
  return { ...model, running: false, turn: null, streaming: null, permissions: [] };
}

export function historyForDisplay(history: ChatModel): ChatModel {
  let tools = history.tools;
  for (const [id, tool] of Object.entries(history.tools)) {
    if (tool.status !== "running" && tool.status !== "streaming") continue;
    if (tools === history.tools) tools = { ...tools };
    tools[id] = { ...tool, status: "stopped" };
  }
  return tools === history.tools ? history : { ...history, tools };
}

export function sessionTitleOf(entries: readonly unknown[]): string | undefined {
  return (
    lastTitleOf(entries, "custom-title", "customTitle") ??
    lastTitleOf(entries, "ai-title", "aiTitle")
  );
}

function lastTitleOf(entries: readonly unknown[], type: string, field: string): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as Record<string, unknown> | null;
    const value = entry?.type === type ? entry[field] : undefined;
    const title = typeof value === "string" ? value.trim() : "";
    if (title) return title;
  }
  return undefined;
}

export function modelUuids(model: ChatModel): Set<string> {
  const uuids = new Set<string>();
  for (const item of model.items) {
    if (
      (item.kind === "user" || item.kind === "assistant" || item.kind === "received") &&
      item.uuid
    ) {
      uuids.add(item.uuid);
    }
  }
  return uuids;
}

export function modelBefore(model: ChatModel, uuid: string): ChatModel {
  const index = model.items.findIndex(
    (item) => (item.kind === "user" || item.kind === "assistant") && item.uuid === uuid,
  );
  const items = index < 0 ? model.items : model.items.slice(0, index);
  return { ...emptyModel(), items, tools: model.tools };
}

export function uuidBefore(model: ChatModel, uuid: string): string | undefined {
  let last: string | undefined;
  for (const item of model.items) {
    if (item.kind !== "user" && item.kind !== "assistant") continue;
    if (item.uuid === uuid) return last;
    if (item.uuid) last = item.uuid;
  }
  return undefined;
}

export function joinHistory(before: ChatModel | null, after: ChatModel): ChatModel {
  if (!before) return { ...after, running: false, turn: null, streaming: null, permissions: [] };
  const keys = new Set(before.items.map((item) => item.key));
  const items = [...before.items];
  for (const item of after.items) {
    let key = item.key;
    for (let n = 2; keys.has(key); n++) key = `${item.key}~${n}`;
    keys.add(key);
    items.push(key === item.key ? item : { ...item, key });
  }
  return {
    ...emptyModel(),
    items,
    tools: { ...before.tools, ...after.tools },
    agentItems: { ...before.agentItems, ...after.agentItems },
  };
}

// A session's transcript as lines the chat model reads, so a tab opened
// after its agent restarted shows the conversation it resumes. Claude Code
// writes one JSON entry per line: the messages, and its own bookkeeping
// (summaries, file snapshots), which is skipped.

import type { ClaudeGoal } from "./goal";
import {
  applyLines,
  type ChatLine,
  type ChatModel,
  emptyModel,
  isCommandOutput,
  SENDER_KINDS,
  typedCommand,
} from "./model";

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

/** Turns transcript entries into stream-json lines. */
export function transcriptLines(entries: readonly unknown[]): ChatLine[] {
  const lines: ChatLine[] = [];
  for (const raw of entries) {
    const entry = rec(raw);
    if (!entry || entry.isSidechain === true) continue;
    // A message that came while a turn ran is kept apart from the others.
    const queued = queuedLine(entry, lines.length + 1);
    if (queued) {
      lines.push(queued);
      continue;
    }
    const kind = rec(entry.origin)?.kind;
    const origin = typeof kind === "string" ? kind : undefined;
    // What the CLI tells the model by itself is not shown, but for what
    // someone sent and a task's end, which the model tells of (notTheUsers).
    const told =
      origin !== undefined && (SENDER_KINDS.has(origin) || origin === "task-notification");
    if (entry.isMeta === true && !told) continue;
    if (entry.type === "user" && entry.promptSource === "system" && !told) continue;
    const goal = goalLine(entry, lines.length + 1);
    if (goal) {
      lines.push(goal);
      continue;
    }
    let message = rec(entry.message);
    if (!message) continue;
    if (entry.type === "user") {
      const text = textOf(message.content);
      // A command's output, which went to the user and not the model.
      if (isCommandOutput(text)) continue;
      const command = typedCommand(text);
      // The /clear a session starts with: the tab shows that as it happens.
      if (command === "/clear") continue;
      if (command !== null) message = { ...message, content: command };
    }
    if (entry.type === "assistant") {
      lines.push({
        seq: lines.length + 1,
        dir: "out",
        replay: true,
        message: { type: "assistant", message, uuid: entry.uuid, timestamp: entry.timestamp },
      });
    } else if (entry.type === "user") {
      const content = message.content;
      const results = Array.isArray(content) && content.some((b) => rec(b)?.type === "tool_result");
      lines.push({
        seq: lines.length + 1,
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
  return lines;
}

/**
 * A message the CLI took while a turn ran, which the transcript keeps as an
 * attachment (queued_command) and not as a message: the user's, another
 * session's, a task's end.
 */
function queuedLine(entry: Rec, seq: number): ChatLine | null {
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

/** The uuid a message that came during a turn was written with, which a log names it by. */
function queuedUuid(entry: Rec): unknown {
  const attachment = rec(entry.attachment);
  return attachment?.type === "queued_command" && typeof attachment.source_uuid === "string"
    ? attachment.source_uuid
    : entry.uuid;
}

/**
 * A goal's part of the transcript as a line: /goal's output when it set or
 * cleared one (the stream's own form of it), and each check of it, which
 * only the transcript keeps once one finds the goal met.
 */
function goalLine(entry: Rec, seq: number): ChatLine | null {
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

/** The goal a session's transcript ends with, as far as it goes. */
export function transcriptGoal(entries: readonly unknown[]): ClaudeGoal | null | undefined {
  return applyLines(emptyModel(), transcriptLines(entries)).goal;
}

/** A message's text: the string, or its first block's. */
function textOf(content: unknown): string {
  const first = Array.isArray(content) ? rec(content[0]) : null;
  return typeof content === "string" ? content : typeof first?.text === "string" ? first.text : "";
}

function isInterrupt(content: unknown): boolean {
  return textOf(content).startsWith("[Request interrupted");
}

export interface HistoryCut {
  /** Keep the entries up to this uuid, it included: a fork's point. */
  upTo?: string;
  /** Keep the entries before the first of these uuids: the ones a log already shows. */
  before?: ReadonlySet<string>;
}

/** The entries a cut keeps. */
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

/** The model of a transcript: its items and tools, nothing running. */
export function historyModel(entries: readonly unknown[], cut?: HistoryCut): ChatModel {
  const model = applyLines(emptyModel(), transcriptLines(cut ? cutEntries(entries, cut) : entries));
  return { ...model, running: false, turn: null, streaming: null, permissions: [] };
}

/**
 * The title a session was given (/rename), the last one standing; else the
 * last one Claude made for it.
 */
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

/** The uuids of the messages a model shows. */
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

/**
 * A model's items before its first one with this uuid: what a rewind to that
 * message keeps. Its tools stay whole; the items left only point at their own.
 */
export function modelBefore(model: ChatModel, uuid: string): ChatModel {
  const index = model.items.findIndex(
    (item) => (item.kind === "user" || item.kind === "assistant") && item.uuid === uuid,
  );
  const items = index < 0 ? model.items : model.items.slice(0, index);
  return { ...emptyModel(), items, tools: model.tools };
}

/** The uuid of the last message before this one: where a fork that leaves it out stops. */
export function uuidBefore(model: ChatModel, uuid: string): string | undefined {
  let last: string | undefined;
  for (const item of model.items) {
    if (item.kind !== "user" && item.kind !== "assistant") continue;
    if (item.uuid === uuid) return last;
    if (item.uuid) last = item.uuid;
  }
  return undefined;
}

/**
 * One history out of two: what was shown before, then what came after. Each
 * numbers its keys from its own log's lines, so one of after's that before
 * has already is keyed anew (a33~2): a list keys its rows by them.
 */
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
  };
}

// A session's transcript as lines the chat model reads, so a tab opened
// after its agent restarted shows the conversation it resumes. Claude Code
// writes one JSON entry per line: the messages, and its own bookkeeping
// (summaries, file snapshots), which is skipped.

import { applyLines, type ChatLine, type ChatModel, emptyModel } from "./model";

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
    if (!entry || entry.isSidechain === true || entry.isMeta === true) continue;
    // What the CLI tells the model by itself, as a task's end: not the user's.
    if (
      entry.type === "user" &&
      (entry.promptSource === "system" || rec(entry.origin)?.kind === "task-notification")
    )
      continue;
    let message = rec(entry.message);
    if (!message) continue;
    if (entry.type === "user") {
      const text = textOf(message.content);
      // A command's output, which went to the user and not the model.
      if (text.startsWith("<local-command-stdout>") || text.startsWith("<local-command-stderr>"))
        continue;
      const command = commandText(text);
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
              },
      });
    }
  }
  return lines;
}

/** A message's text: the string, or its first block's. */
function textOf(content: unknown): string {
  const first = Array.isArray(content) ? rec(content[0]) : null;
  return typeof content === "string" ? content : typeof first?.text === "string" ? first.text : "";
}

function isInterrupt(content: unknown): boolean {
  return textOf(content).startsWith("[Request interrupted");
}

/**
 * A command the user ran, as the transcript records it
 * (`<command-name>/clear</command-name>…<command-args>…`), written as typed;
 * null for any other text.
 */
function commandText(text: string): string | null {
  const name = /^\s*<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  const typed = name.startsWith("/") ? name : `/${name}`;
  return args ? `${typed} ${args}` : typed;
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
    const uuid = rec(raw)?.uuid;
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

/** The uuids of the messages a model shows. */
export function modelUuids(model: ChatModel): Set<string> {
  const uuids = new Set<string>();
  for (const item of model.items) {
    if ((item.kind === "user" || item.kind === "assistant") && item.uuid) uuids.add(item.uuid);
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

/** One history out of two: what was shown before, then what came after. */
export function joinHistory(before: ChatModel | null, after: ChatModel): ChatModel {
  if (!before) return { ...after, running: false, turn: null, streaming: null, permissions: [] };
  return {
    ...emptyModel(),
    items: [...before.items, ...after.items],
    tools: { ...before.tools, ...after.tools },
  };
}

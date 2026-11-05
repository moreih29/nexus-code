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
    const message = rec(entry.message);
    if (!message) continue;
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

function isInterrupt(content: unknown): boolean {
  const first = Array.isArray(content) ? rec(content[0]) : null;
  const text =
    typeof content === "string" ? content : typeof first?.text === "string" ? first.text : "";
  return text.startsWith("[Request interrupted");
}

/** The model of a transcript: its items and tools, nothing running. */
export function historyModel(entries: readonly unknown[]): ChatModel {
  const model = applyLines(emptyModel(), transcriptLines(entries));
  return { ...model, running: false, turn: null, streaming: null, permissions: [] };
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

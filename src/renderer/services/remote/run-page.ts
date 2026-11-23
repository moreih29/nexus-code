import type { ChatPage } from "../../../../packages/remote-protocol/src";
import { ipcCallResult } from "../../ipc/client";
import { historyModel } from "../chat/claude/history";
import type { ChatModel } from "../chat/model";
import {
  type CodexRunReader,
  mergeRunLines,
  NO_RUN_LINES,
  openCodexRunReader,
  RUN_READER_ATTEMPTS,
  type RunLines,
  type RunReaderMiss,
} from "../chat/print-run-transcript";
import { emptyTabState } from "../chat/store";
import { chatPageOf } from "./chat-page";

export const RUN_PAGE_KEPT_MS = 30_000;

export const RUN_THREAD_FRESH_MS = 2_000;

interface Kept {
  lines: RunLines;
  model?: ChatModel;
  readAt?: number;
  reader?: Promise<CodexRunReader | RunReaderMiss>;
  failed?: number;
  timer?: ReturnType<typeof setTimeout>;
}

const kept = new Map<string, Kept>();

function drop(key: string): void {
  const entry = kept.get(key);
  if (!entry) return;
  kept.delete(key);
  clearTimeout(entry.timer);
  void entry.reader?.then((reader) => {
    if (typeof reader !== "string") reader.close();
  });
}

export async function runPageOf(
  workspaceId: string,
  tabId: string,
  runId: string,
  window: { before?: number; limit?: number } = {},
): Promise<ChatPage | null> {
  const key = `${workspaceId}:${tabId}:${runId}`;
  const entry = kept.get(key) ?? { lines: NO_RUN_LINES };
  kept.set(key, entry);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => drop(key), RUN_PAGE_KEPT_MS);

  let agent: "claude" | "codex" = "claude";
  let model: ChatModel | null = null;
  if (!entry.reader) {
    const prev = entry.lines;
    const read = await ipcCallResult("chat", "printRunTranscript", {
      workspaceId,
      tabId,
      runId,
      ...(prev.found ? { from: prev.next } : {}),
    });
    if (read.ok && entry.lines === prev) {
      entry.lines = mergeRunLines(prev, read.value);
      if (entry.lines !== prev) entry.model = undefined;
    }
    if (entry.lines.found) {
      entry.model ??= historyModel(entry.lines.lines);
      model = entry.model;
    }
  }
  if (!model) {
    agent = "codex";
    if (!entry.reader && (entry.failed ?? 0) >= RUN_READER_ATTEMPTS) return null;
    entry.reader ??= openCodexRunReader(workspaceId, tabId, runId);
    const opening = entry.reader;
    const opened = await opening;
    const reader = typeof opened === "string" ? null : opened;
    const fresh =
      entry.model && entry.readAt !== undefined && Date.now() - entry.readAt < RUN_THREAD_FRESH_MS;
    if (fresh) model = entry.model ?? null;
    else {
      model = reader && !reader.dead ? await reader.read().catch(() => null) : null;
      entry.model = model ?? undefined;
      entry.readAt = model ? Date.now() : undefined;
      if (model) entry.failed = 0;
    }
    if (!reader || reader.dead) {
      if (entry.reader === opening) {
        entry.reader = undefined;
        if (opened !== "none") entry.failed = (entry.failed ?? 0) + 1;
      }
      reader?.close();
      return null;
    }
  }
  if (!model || model.items.length === 0) return null;
  return chatPageOf({ agent, title: "", chat: { ...emptyTabState(), model } }, window);
}

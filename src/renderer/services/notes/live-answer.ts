import { slashWindowsPath } from "../../../shared/fs/relative-path";
import {
  liveAnswerPreview,
  liveAnswerTime,
  type NoteLastAnswer,
} from "../../../shared/notes/links";
import { codexItemTools } from "../chat/codex/model";
import { type ChatItem, type ChatModel, num, opensTurn, rec, str } from "../chat/model";
import { changedFilesOf } from "../chat/panel";
import type { ChatTabState } from "../chat/store";

function liveCardFileCount(tools: ChatModel["tools"]): number {
  const paths = new Set(changedFilesOf(tools).map(({ path }) => path));
  for (const tool of Object.values(tools)) {
    if (tool.name !== "Delete" || tool.status !== "done") continue;
    const file = str(rec(tool.input)?.file_path);
    if (file) paths.add(slashWindowsPath(file));
  }
  return paths.size;
}

function startsRecordedTurn(item: ChatItem): boolean {
  return item.kind === "user" ? item.state === "taken" : opensTurn(item);
}

function recordedTurnItems(items: ChatItem[], answerIndex: number): ChatItem[] | undefined {
  let start = answerIndex;
  while (start > 0 && !startsRecordedTurn(items[start - 1])) start--;
  if (start === 0) return;
  let end = answerIndex + 1;
  while (end < items.length && !startsRecordedTurn(items[end])) end++;
  return items.slice(start, end);
}

function answerTurnFiles(model: ChatModel, answerIndex: number): number | undefined {
  const answer = model.items[answerIndex];
  if (answer.kind !== "assistant") return;
  const items = answer.turnId
    ? model.items.filter((item) => item.kind === "assistant" && item.turnId === answer.turnId)
    : recordedTurnItems(model.items, answerIndex);
  if (!items) return;
  const tools: ChatModel["tools"] = {};
  for (const item of items) {
    if (item.kind !== "assistant") continue;
    for (const block of item.blocks) {
      if (block.type !== "tool") continue;
      const tool = model.tools[block.toolUseId];
      if (!tool) return;
      tools[tool.id] = tool;
    }
  }
  return liveCardFileCount(tools);
}

function modelAnswer(
  model: ChatModel,
  includes: (item: Extract<ChatItem, { kind: "assistant" }>) => boolean,
  endAt?: number,
): NoteLastAnswer | undefined {
  for (let index = model.items.length - 1; index >= 0; index--) {
    const item = model.items[index];
    if (item.kind !== "assistant" || !includes(item)) continue;
    const text = liveAnswerPreview(
      item.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n"),
    );
    if (!text) continue;
    const turnFiles = answerTurnFiles(model, index);
    const now = Date.now();
    return {
      text,
      at: liveAnswerTime(endAt ?? item.at ?? now, now),
      ...(turnFiles !== undefined ? { turnFiles } : {}),
    };
  }
}

export function liveAnswerOf(model: ChatModel): NoteLastAnswer | undefined {
  const result = model.lastResult;
  if (!result?.turnId || model.running) return;
  return modelAnswer(model, (item) => item.turnId === result.turnId, result.at);
}

export function historicalAnswerOf(model: ChatModel) {
  return modelAnswer(model, () => true);
}

export function loadedAnswerOf(state: ChatTabState | undefined): NoteLastAnswer | undefined {
  if (!state) return;
  const { model, history } = state;
  const turn = model.turn;
  const answer = model.running
    ? modelAnswer(model, (item) =>
        turn?.id && item.turnId
          ? item.turnId !== turn.id
          : turn?.startedAt !== undefined && item.at !== undefined && item.at < turn.startedAt,
      )
    : (liveAnswerOf(model) ?? historicalAnswerOf(model));
  return answer ?? (history ? historicalAnswerOf(history) : undefined);
}

export function codexStoredAnswer(turns: readonly unknown[]): NoteLastAnswer | undefined {
  for (const raw of turns) {
    const turn = rec(raw);
    if (!turn || turn.status === "inProgress" || !Array.isArray(turn.items)) continue;
    for (let index = turn.items.length - 1; index >= 0; index--) {
      const item = rec(turn.items[index]);
      if (item?.type !== "agentMessage" || typeof item.text !== "string") continue;
      const text = liveAnswerPreview(item.text);
      if (!text) continue;
      const turnAt = num(turn.completedAt) ?? num(turn.startedAt);
      const at =
        num(item.completedAtMs) ??
        num(item.startedAtMs) ??
        (turnAt === undefined ? Date.now() : turnAt * 1000);
      return {
        text,
        at: liveAnswerTime(at),
        ...(turn.itemsView === "full" ? { turnFiles: codexStoredFileCount(turn.items) } : {}),
      };
    }
  }
}

function codexStoredFileCount(items: unknown[]): number {
  const tools: ChatModel["tools"] = {};
  for (const raw of items) {
    const item = rec(raw);
    const id = str(item?.id);
    if (!id || item?.type !== "fileChange" || item.status === "inProgress") continue;
    for (const tool of codexItemTools(item, id, "completed") ?? []) tools[tool.id] = tool;
  }
  return liveCardFileCount(tools);
}

import { liveAnswerText, type NoteLastAnswer } from "../../../shared/notes/links";
import { type ChatModel, num, rec } from "../chat/model";
import { changedFilesOf } from "../chat/panel";
import type { ChatTabState } from "../chat/store";

function modelAnswer(
  model: ChatModel,
  {
    endAt,
    before,
    currentTurn = false,
  }: { endAt?: number; before?: number; currentTurn?: boolean } = {},
): NoteLastAnswer | undefined {
  for (let index = model.items.length - 1; index >= 0; index--) {
    const item = model.items[index];
    if (currentTurn && item.kind === "user" && item.state === "taken") return;
    if (item.kind !== "assistant") continue;
    if (before !== undefined && (item.at === undefined || item.at >= before)) continue;
    const text = liveAnswerText(
      item.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" "),
    );
    if (!text) continue;
    const files = before === undefined ? changedFilesOf(model.tools).length : 0;
    return { text, at: endAt ?? item.at ?? Date.now(), ...(files ? { files } : {}) };
  }
}

/** The latest completed answer, from the chat model and its recorded edits. */
export function liveAnswerOf(model: ChatModel): NoteLastAnswer | undefined {
  const result = model.lastResult;
  if (!result || model.running) return;
  return modelAnswer(model, { endAt: result.at, currentTurn: true });
}

export function historicalAnswerOf(model: ChatModel) {
  return modelAnswer(model);
}

export function loadedAnswerOf(state: ChatTabState | undefined): NoteLastAnswer | undefined {
  if (!state) return;
  const { model, history } = state;
  const before = model.turn?.startedAt;
  const answer = model.running
    ? before !== undefined && modelAnswer(model, { before })
    : (liveAnswerOf(model) ?? historicalAnswerOf(model));
  return answer || (history ? historicalAnswerOf(history) : undefined);
}

export function codexStoredAnswer(turns: readonly unknown[]): NoteLastAnswer | undefined {
  for (const raw of turns) {
    const turn = rec(raw);
    if (!turn || turn.status === "inProgress" || !Array.isArray(turn.items)) continue;
    for (let index = turn.items.length - 1; index >= 0; index--) {
      const item = rec(turn.items[index]);
      if (item?.type !== "agentMessage" || typeof item.text !== "string") continue;
      const text = liveAnswerText(item.text);
      if (!text) continue;
      const turnAt = num(turn.completedAt) ?? num(turn.startedAt);
      const at =
        num(item.completedAtMs) ??
        num(item.startedAtMs) ??
        (turnAt === undefined ? Date.now() : turnAt * 1000);
      return { text, at };
    }
  }
}

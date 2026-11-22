import { liveAnswerText, type NoteLastAnswer } from "../../../shared/notes/links";
import type { ChatModel } from "../chat/model";
import { changedFilesOf } from "../chat/panel";

/** The latest completed answer, from the chat model and its recorded edits. */
export function liveAnswerOf(model: ChatModel): NoteLastAnswer | undefined {
  const result = model.lastResult;
  if (!result || model.running) return;
  for (let index = model.items.length - 1; index >= 0; index--) {
    const item = model.items[index];
    if (item.kind === "user" && item.state === "taken") return;
    if (item.kind !== "assistant") continue;
    const text = liveAnswerText(
      item.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" "),
    );
    if (!text) continue;
    const files = changedFilesOf(model.tools).length;
    return { text, at: result.at ?? Date.now(), ...(files ? { files } : {}) };
  }
}

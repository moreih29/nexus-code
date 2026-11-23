import { type CodexModel, originalsFor } from "../chat/codex/model";
import { changedFilesOf } from "../chat/panel";
import type { ChatTabState } from "../chat/store";

export function originalOf(chat: ChatTabState, path: string): string | null | undefined {
  const codex = (chat.model as Partial<CodexModel>).originals;
  const kept: Record<string, string | null> = { ...codex };
  if (!codex) {
    const tools = chat.history ? { ...chat.history.tools, ...chat.model.tools } : chat.model.tools;
    for (const file of changedFilesOf(tools)) {
      if (file.before !== undefined) kept[file.path] = file.before;
    }
  }
  return originalsFor(kept, [path])[path];
}

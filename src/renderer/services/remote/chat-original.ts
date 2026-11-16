/**
 * A file a chat's session changed as it was before its first change, as
 * the chat here shows its diff, for another device to show it the same
 * (chat.original): a Codex chat's from the originals the agent took of the
 * files its turns changed, a Claude chat's from what its first edit of the
 * file reported, the history read before its program ran included. Null
 * for a file the session wrote new.
 */

import { type CodexModel, originalsFor } from "../chat/codex-model";
import { changedFilesOf } from "../chat/panel";
import type { ChatTabState } from "../chat/store";

/** The file's original, by its path as the chat's changes name it; undefined when not kept. */
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

// A chat tab's conversation can go on in another profile (the profile
// chip): a copy of it does, and a line in the conversation says where. The
// line follows the last message before the move, found again by its id
// when the conversation is read anew.

import { isDefaultProfileId } from "../../../shared/agent-profiles/profiles";
import { PROFILE_MOVES_KEPT, type ProfileMove } from "../../../shared/types/layout";
import type { ChatItem } from "./model";

/** Whether two of a tab's profile ids name one profile: none is the default. */
export function sameProfile(a: string | undefined, b: string | undefined): boolean {
  const own = (id: string | undefined) => (id && !isDefaultProfileId(id) ? id : undefined);
  return own(a) === own(b);
}

/**
 * The id of the last message a conversation shows, for a line to follow it
 * (followsMessage): a message's uuid, else the message (Codex's turn) an
 * answer belongs to.
 */
export function lastMessageId(items: readonly ChatItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "user" && item.uuid) return item.uuid;
    if (item.kind === "assistant") {
      const id = item.uuid ?? item.messageId;
      if (id) return id;
    }
  }
  return undefined;
}

/** Whether a line that follows the message `id` (lastMessageId) goes after this item. */
export function followsMessage(item: ChatItem, id: string): boolean {
  if (item.kind === "user") return item.uuid === id;
  return item.kind === "assistant" && (item.uuid === id || item.messageId === id);
}

/**
 * The moves a conversation keeps with one more: the profile it went on in
 * after its last message. A move with no message since the last one takes
 * that one's place.
 */
export function withMove(
  moves: readonly ProfileMove[] | undefined,
  move: ProfileMove,
): ProfileMove[] {
  const kept = (moves ?? []).filter((m) => m.after !== move.after);
  return [...kept, move].slice(-PROFILE_MOVES_KEPT);
}

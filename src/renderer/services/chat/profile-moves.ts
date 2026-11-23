import { isDefaultProfileId } from "../../../shared/agent-profiles/profiles";
import { PROFILE_MOVES_KEPT, type ProfileMove } from "../../../shared/types/layout";
import type { ChatItem } from "./model";

export function sameProfile(a: string | undefined, b: string | undefined): boolean {
  const own = (id: string | undefined) => (id && !isDefaultProfileId(id) ? id : undefined);
  return own(a) === own(b);
}

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

export function followsMessage(item: ChatItem, id: string): boolean {
  if (item.kind === "user" || item.kind === "received") return item.uuid === id;
  return item.kind === "assistant" && (item.uuid === id || item.messageId === id);
}

export function withMove(
  moves: readonly ProfileMove[] | undefined,
  move: ProfileMove,
): ProfileMove[] {
  const kept = (moves ?? []).filter((m) => m.after !== move.after);
  return [...kept, move].slice(-PROFILE_MOVES_KEPT);
}

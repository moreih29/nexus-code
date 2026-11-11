/**
 * The part of a conversation its list renders.
 *
 * A list that renders every message keeps every message's elements, and
 * renders them all again each time a call changes: a session that runs for a
 * day holds thousands, and its page grows until it runs out of memory. So the
 * list renders the last messages, and earlier ones on asking.
 */
import { type ChatItem, opensTurn } from "./model";

/** How many messages a list renders at first, and adds each time more is asked for. */
export const WINDOW_ITEMS = 150;

/**
 * Where the rendered part of `items` starts so that it holds the last `size`:
 * moved back to where the turn it starts in begins, so a turn shows whole
 * (its folded calls, what its answer ends with), unless that turn alone is
 * longer than `size` again. 0 when they all fit.
 */
export function windowStart(items: readonly ChatItem[], size: number): number {
  if (items.length <= size) return 0;
  const start = items.length - size;
  const limit = Math.max(0, start - size);
  for (let i = start; i > limit; i--) {
    const before = items[i - 1];
    if (before && opensTurn(before)) return i - 1;
  }
  return start;
}

/**
 * Where the rendered part starts this time. At the bottom it follows the
 * conversation (windowStart). Up the list it stays where it was, so what the
 * user reads stays put as messages come in, until the rendered part is twice
 * its size; then its top moves down as they come, a view left up the list
 * overnight rendering no more than that. The browser's scroll anchoring keeps
 * the view on what it shows as messages above it go.
 */
export function shownStart(options: {
  /** windowStart of the conversation now. */
  fresh: number;
  /** Where it started the last time. */
  held: number;
  /** Whether the view is at the bottom. */
  stuck: boolean;
  /** How many messages the conversation has. */
  total: number;
  /** How many it renders: WINDOW_ITEMS and those asked for. */
  size: number;
}): number {
  const { fresh, held, stuck, total, size } = options;
  if (stuck) return fresh;
  return Math.max(Math.min(fresh, held), total - 2 * size);
}

/**
 * The index of the message that holds one of `toolUseIds`' calls, for the
 * list to render down to it when the side panel asks to see the call; -1
 * when none does.
 */
export function indexOfCall(items: readonly ChatItem[], toolUseIds: ReadonlySet<string>): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "assistant") continue;
    if (item.blocks.some((block) => block.type === "tool" && toolUseIds.has(block.toolUseId))) {
      return i;
    }
  }
  return -1;
}

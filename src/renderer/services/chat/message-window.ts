import { type ChatItem, opensTurn } from "./model";

export const WINDOW_ITEMS = 150;

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

export function shownStart(options: {
  fresh: number;
  held: number;
  stuck: boolean;
  total: number;
  size: number;
}): number {
  const { fresh, held, stuck, total, size } = options;
  if (stuck) return fresh;
  return Math.max(Math.min(fresh, held), total - 2 * size);
}

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

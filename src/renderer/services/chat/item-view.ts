/**
 * What one message of a conversation's list renders from, besides itself.
 *
 * The list's sources (the calls, what each message shows, what each answer
 * ends with, the images each turn shows) are made again whenever a call
 * changes. A message given them whole renders again each time, so the list
 * renders every message again per call. Each message gets its part of them
 * instead, which stays the same until something it shows changes: one of
 * its calls (or a call under one, a subagent's), its folded runs, an image
 * its turn showed before, its answer's files, or the side panel asking for
 * a call of its runs. Its part holds no more than it reads, so a message
 * that has not rendered for a while keeps no old copy of the whole.
 */
import type { AssistantBlock, AssistantItem, ChatItem, ToolCall } from "./model";
import type { AnswerExtras, ImagesShownEarlier } from "./panel";
import type { ShownBlock } from "./tool-runs";

/** A message's part of its list's sources. */
export interface ItemView {
  /** What it shows: its blocks, with calls in a row folded together. */
  blocks: readonly ShownBlock[];
  /** Its calls and the calls they run (a subagent's), by id. */
  tools: Readonly<Record<string, ToolCall>>;
  /** What its answer ends with. */
  extras?: AnswerExtras;
  /** By part, the image files it shows that its turn showed before. */
  earlier: ReadonlyMap<AssistantBlock | string, ReadonlySet<string>>;
  /** The side panel's ask, when it asks for a call in one of its runs. */
  asked?: { ids: ReadonlySet<string> };
}

/** What a list renders its messages from. */
export interface ListSources {
  tools: Record<string, ToolCall>;
  /** By a call's id, the calls it runs (callsUnder). */
  callsUnder: ReadonlyMap<string, readonly ToolCall[]>;
  shown: ReadonlyMap<AssistantItem, readonly ShownBlock[]>;
  extras: ReadonlyMap<ChatItem, AnswerExtras>;
  earlier: ImagesShownEarlier;
  asked?: { ids: ReadonlySet<string> };
}

const NO_EARLIER: ReadonlyMap<AssistantBlock | string, ReadonlySet<string>> = new Map();

/** By a call's id, the calls it runs, in the order `tools` has them. */
export function callsUnder(tools: Record<string, ToolCall>): Map<string, ToolCall[]> {
  const out = new Map<string, ToolCall[]>();
  for (const tool of Object.values(tools)) {
    const parent = tool.parentToolUseId;
    if (!parent) continue;
    const calls = out.get(parent);
    if (calls) calls.push(tool);
    else out.set(parent, [tool]);
  }
  return out;
}

/** An assistant message's part of `sources`; other messages render from themselves alone. */
export function itemView(item: ChatItem, sources: ListSources): ItemView | undefined {
  if (item.kind !== "assistant") return undefined;
  const blocks = sources.shown.get(item) ?? item.blocks;
  const tools: Record<string, ToolCall> = {};
  const taken = new Set<string>();
  const take = (id: string) => {
    if (taken.has(id)) return;
    taken.add(id);
    const tool = sources.tools[id];
    if (tool) tools[id] = tool;
    for (const call of sources.callsUnder.get(id) ?? []) take(call.id);
  };
  const earlier = new Map<AssistantBlock | string, ReadonlySet<string>>();
  const part = (block: AssistantBlock) => {
    const key = block.type === "tool" ? block.toolUseId : block;
    const files = sources.earlier.byPart.get(key);
    if (files) earlier.set(key, files);
    if (block.type === "tool") take(block.toolUseId);
  };
  let asked: ItemView["asked"];
  for (const block of blocks) {
    if (block.type !== "run") {
      part(block);
      continue;
    }
    for (const inner of block.blocks) part(inner);
    const ask = sources.asked;
    if (ask && block.blocks.some((b) => b.type === "tool" && ask.ids.has(b.toolUseId))) {
      asked = ask;
    }
  }
  const extras = sources.extras.get(item);
  return {
    blocks,
    tools,
    earlier: earlier.size > 0 ? earlier : NO_EARLIER,
    ...(extras ? { extras } : {}),
    ...(asked ? { asked } : {}),
  };
}

/** Whether a message renders the same from `a` as from `b`. */
export function sameView(a: ItemView | undefined, b: ItemView | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.asked === b.asked &&
    sameBlocks(a.blocks, b.blocks) &&
    sameRecord(a.tools, b.tools) &&
    sameExtras(a.extras, b.extras) &&
    sameEarlier(a.earlier, b.earlier)
  );
}

function sameBlocks(a: readonly ShownBlock[], b: readonly ShownBlock[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (x === y) return true;
    return x.type === "run" && y?.type === "run" && sameList(x.blocks, y.blocks);
  });
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameRecord(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function sameExtras(a: AnswerExtras | undefined, b: AnswerExtras | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    sameList(a.files, b.files) &&
    a.images.length === b.images.length &&
    a.images.every((x, i) => x.image === b.images[i]?.image && x.file === b.images[i]?.file)
  );
}

function sameEarlier(a: ItemView["earlier"], b: ItemView["earlier"]): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, files] of a) {
    const other = b.get(key);
    if (!other || other.size !== files.size) return false;
    for (const file of files) if (!other.has(file)) return false;
  }
  return true;
}

import type { AssistantBlock, AssistantItem, ChatItem, ToolCall } from "./model";
import type { AnswerExtras, ImagesShownEarlier } from "./panel";
import type { ToolRowStatus, ToolRowStatuses } from "./running";
import type { ShownBlock } from "./tool-runs";

export interface ItemView {
  blocks: readonly ShownBlock[];
  tools: Readonly<Record<string, ToolCall>>;
  toolStatuses: ToolRowStatuses;
  extras?: AnswerExtras;
  earlier: ReadonlyMap<AssistantBlock | string, ReadonlySet<string>>;
  asked?: { ids: ReadonlySet<string> };
}

export interface ListSources {
  tools: Record<string, ToolCall>;
  toolStatuses: ToolRowStatuses;
  callsUnder: ReadonlyMap<string, readonly ToolCall[]>;
  shown: ReadonlyMap<AssistantItem, readonly ShownBlock[]>;
  extras: ReadonlyMap<ChatItem, AnswerExtras>;
  earlier: ImagesShownEarlier;
  asked?: { ids: ReadonlySet<string> };
}

const NO_EARLIER: ReadonlyMap<AssistantBlock | string, ReadonlySet<string>> = new Map();

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

export function itemView(item: ChatItem, sources: ListSources): ItemView | undefined {
  if (item.kind !== "assistant") return undefined;
  const blocks = sources.shown.get(item) ?? item.blocks;
  const tools: Record<string, ToolCall> = {};
  const toolStatuses: Partial<Record<string, ToolRowStatus>> = {};
  const taken = new Set<string>();
  const take = (id: string) => {
    if (taken.has(id)) return;
    taken.add(id);
    const tool = sources.tools[id];
    if (tool) tools[id] = tool;
    const status = sources.toolStatuses[id];
    if (status) toolStatuses[id] = status;
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
    toolStatuses,
    earlier: earlier.size > 0 ? earlier : NO_EARLIER,
    ...(extras ? { extras } : {}),
    ...(asked ? { asked } : {}),
  };
}

export function sameView(a: ItemView | undefined, b: ItemView | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.asked === b.asked &&
    sameBlocks(a.blocks, b.blocks) &&
    sameRecord(a.tools, b.tools) &&
    sameRecord(a.toolStatuses, b.toolStatuses) &&
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

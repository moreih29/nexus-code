import { ARTIFACT_TOOL } from "./artifact";
import type { AssistantBlock, AssistantItem, ChatItem, ToolCall } from "./model";
import { AGENT_TOOLS, SEND_FILES_TOOL } from "./panel";
import type { ToolRowStatuses } from "./running";

const LONE_TOOLS = new Set([
  ...AGENT_TOOLS,
  "AskUserQuestion",
  "ExitPlanMode",
  SEND_FILES_TOOL,
  ARTIFACT_TOOL,
]);

export const MIN_RUN = 2;

export type ShownBlock = AssistantBlock | { type: "run"; blocks: AssistantBlock[] };

export function isLoneTool(name: string): boolean {
  return LONE_TOOLS.has(name);
}

export type RunPart = "call" | "between" | "end";

export type FoldedEntry<T> = { readonly one: T } | { readonly run: readonly T[] };

export function foldRuns<T>(entries: readonly T[], part: (entry: T) => RunPart): FoldedEntry<T>[] {
  const out: FoldedEntry<T>[] = [];
  let i = 0;
  while (i < entries.length) {
    if (part(entries[i]) === "call") {
      let last = i;
      let calls = 0;
      for (let j = i; j < entries.length; j++) {
        const kind = part(entries[j]);
        if (kind === "call") {
          last = j;
          calls++;
        } else if (kind !== "between") break;
      }
      if (calls >= MIN_RUN) {
        out.push({ run: entries.slice(i, last + 1) });
        i = last + 1;
        continue;
      }
    }
    out.push({ one: entries[i] });
    i++;
  }
  return out;
}

export function foldToolRuns(
  items: readonly ChatItem[],
  tools: Record<string, ToolCall>,
): Map<AssistantItem, ShownBlock[]> {
  const shown = new Map<AssistantItem, ShownBlock[]>();
  const part = ({ block }: { block: AssistantBlock }): RunPart =>
    block.type === "tool" && !isLoneTool(tools[block.toolUseId]?.name ?? "")
      ? "call"
      : block.type === "thinking"
        ? "between"
        : "end";

  let entries: { item: AssistantItem; block: AssistantBlock }[] = [];
  const flush = () => {
    for (const entry of foldRuns(entries, part)) {
      const first = "one" in entry ? entry.one : entry.run[0];
      const into = shown.get(first.item) ?? [];
      into.push(
        "one" in entry ? entry.one.block : { type: "run", blocks: entry.run.map((e) => e.block) },
      );
      shown.set(first.item, into);
    }
    entries = [];
  };

  for (const item of items) {
    if (item.kind !== "assistant") {
      flush();
      continue;
    }
    shown.set(item, []);
    for (const block of item.blocks) entries.push({ item, block });
  }
  flush();
  return shown;
}

const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash", "PowerShell"]);
const READ_TOOLS = new Set(["Read", "NotebookRead", "ViewImage"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Delete"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS", "WebSearch", "ToolSearch"]);

export interface RunTally {
  commands: number;
  reads: number;
  edits: number;
  searches: number;
  others: number;
  failed: number;
  denied: number;
}

export interface RunCall {
  readonly name: string;
  readonly path?: string;
  readonly status?: string;
}

export function tallyRun(
  calls: readonly (ToolCall | undefined)[],
  toolStatuses: ToolRowStatuses,
): RunTally {
  return tallyCalls(
    calls.map((call) => {
      const input = (call?.input ?? {}) as Record<string, unknown>;
      return {
        name: call?.name ?? "",
        path: [input.file_path, input.notebook_path].find(
          (value): value is string => typeof value === "string" && value !== "",
        ),
        status: call && (toolStatuses[call.id] ?? call.status),
      };
    }),
  );
}

export function tallyCalls(calls: readonly RunCall[]): RunTally {
  const tally: RunTally = {
    commands: 0,
    reads: 0,
    edits: 0,
    searches: 0,
    others: 0,
    failed: 0,
    denied: 0,
  };
  const read = new Set<string>();
  const edited = new Set<string>();
  for (const { name, path, status } of calls) {
    if (status === "error") tally.failed++;
    if (status === "denied") tally.denied++;
    if (COMMAND_TOOLS.has(name)) tally.commands++;
    else if (READ_TOOLS.has(name)) {
      if (!path) tally.reads++;
      else read.add(path);
    } else if (EDIT_TOOLS.has(name)) {
      if (!path) tally.edits++;
      else edited.add(path);
    } else if (SEARCH_TOOLS.has(name)) tally.searches++;
    else tally.others++;
  }
  tally.reads += read.size;
  tally.edits += edited.size;
  return tally;
}

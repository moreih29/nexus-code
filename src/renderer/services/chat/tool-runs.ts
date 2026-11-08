// Tool calls in a row, folded into one line: a turn that ran ten commands
// and read five files reads as that, and opens to show each call. Pure.

import type { AssistantBlock, AssistantItem, ChatItem, ToolCall } from "./model";
import { AGENT_TOOLS, SEND_FILES_TOOL } from "./panel";

/**
 * Calls that keep a line of their own: a subagent's, those that ask the
 * user, and one that puts files in front of the user.
 */
const LONE_TOOLS = new Set([...AGENT_TOOLS, "AskUserQuestion", "ExitPlanMode", SEND_FILES_TOOL]);

/** Fewest calls in a row that fold into one line. */
export const MIN_RUN = 2;

/** A block as a message shows it: as it came, or calls in a row folded together. */
export type ShownBlock = AssistantBlock | { type: "run"; blocks: AssistantBlock[] };

/**
 * What each assistant message shows: its blocks, with calls in a row folded
 * into a run. A run goes on across messages, as Claude makes a call a
 * message, and is shown in the message it begins in; one whose blocks all
 * went into an earlier run shows none. Thinking between two calls goes in
 * the run; text, a lone call or the user's turn ends it.
 */
export function foldToolRuns(
  items: readonly ChatItem[],
  tools: Record<string, ToolCall>,
): Map<AssistantItem, ShownBlock[]> {
  const shown = new Map<AssistantItem, ShownBlock[]>();
  const foldable = (block: AssistantBlock) =>
    block.type === "tool" && !LONE_TOOLS.has(tools[block.toolUseId]?.name ?? "");

  let entries: { item: AssistantItem; block: AssistantBlock }[] = [];
  const flush = () => {
    let i = 0;
    while (i < entries.length) {
      const { item, block } = entries[i];
      const into = shown.get(item) ?? [];
      if (foldable(block)) {
        let last = i;
        let calls = 0;
        for (let j = i; j < entries.length; j++) {
          const next = entries[j].block;
          if (foldable(next)) {
            last = j;
            calls++;
          } else if (next.type !== "thinking") break;
        }
        if (calls >= MIN_RUN) {
          into.push({ type: "run", blocks: entries.slice(i, last + 1).map((e) => e.block) });
          i = last + 1;
          continue;
        }
      }
      into.push(block);
      i++;
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

/** What a run did, by kind: files read or edited count once however often. */
export interface RunTally {
  commands: number;
  reads: number;
  edits: number;
  searches: number;
  others: number;
  failed: number;
  denied: number;
}

export function tallyRun(calls: readonly (ToolCall | undefined)[]): RunTally {
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
  for (const call of calls) {
    if (call?.status === "error") tally.failed++;
    if (call?.status === "denied") tally.denied++;
    const name = call?.name ?? "";
    const input = (call?.input ?? {}) as Record<string, unknown>;
    const path = [input.file_path, input.notebook_path].find(
      (value): value is string => typeof value === "string" && value !== "",
    );
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

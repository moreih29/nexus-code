import { describe, expect, test } from "bun:test";
import type {
  AssistantBlock,
  AssistantItem,
  ChatItem,
  ToolCall,
} from "../../../../../src/renderer/services/chat/model";
import { foldToolRuns, tallyRun } from "../../../../../src/renderer/services/chat/tool-runs";

function call(id: string, name: string, input: Record<string, unknown> = {}): ToolCall {
  return { id, name, input, status: "done", parentToolUseId: null };
}

function assistant(key: string, ...blocks: AssistantBlock[]): AssistantItem {
  return { kind: "assistant", key, messageId: key, blocks };
}

const tool = (toolUseId: string): AssistantBlock => ({ type: "tool", toolUseId });
const text = (value: string): AssistantBlock => ({ type: "text", text: value });
const thinking = (value: string): AssistantBlock => ({ type: "thinking", text: value });

const TOOLS: Record<string, ToolCall> = {
  b1: call("b1", "Bash", { command: "ls" }),
  b2: call("b2", "Bash", { command: "pwd" }),
  r1: call("r1", "Read", { file_path: "/p/a.ts" }),
  ag: call("ag", "Agent", { prompt: "go" }),
  q: call("q", "AskUserQuestion"),
};

describe("foldToolRuns", () => {
  test("calls in a row across messages fold into the message they begin in", () => {
    const a1 = assistant("a1", text("Looking."), tool("b1"));
    const a2 = assistant("a2", tool("r1"));
    const a3 = assistant("a3", tool("b2"));
    const a4 = assistant("a4", text("Done."));
    const shown = foldToolRuns([a1, a2, a3, a4], TOOLS);
    expect(shown.get(a1)).toEqual([
      text("Looking."),
      { type: "run", blocks: [tool("b1"), tool("r1"), tool("b2")] },
    ]);
    expect(shown.get(a2)).toEqual([]);
    expect(shown.get(a3)).toEqual([]);
    expect(shown.get(a4)).toEqual([text("Done.")]);
  });

  test("a single call keeps its own line", () => {
    const a1 = assistant("a1", tool("b1"), text("ok"));
    expect(foldToolRuns([a1], TOOLS).get(a1)).toEqual([tool("b1"), text("ok")]);
  });

  test("thinking between calls joins the run, thinking around it does not", () => {
    const a1 = assistant("a1", thinking("t0"), tool("b1"));
    const a2 = assistant("a2", thinking("t1"), tool("b2"));
    const a3 = assistant("a3", thinking("t2"), text("ok"));
    const shown = foldToolRuns([a1, a2, a3], TOOLS);
    expect(shown.get(a1)).toEqual([
      thinking("t0"),
      { type: "run", blocks: [tool("b1"), thinking("t1"), tool("b2")] },
    ]);
    expect(shown.get(a2)).toEqual([]);
    expect(shown.get(a3)).toEqual([thinking("t2"), text("ok")]);
  });

  test("the user's turn and lone calls end a run", () => {
    const a1 = assistant("a1", tool("b1"));
    const user: ChatItem = { kind: "user", key: "u", text: "hi", images: [], state: "taken" };
    const a2 = assistant("a2", tool("b2"));
    const a3 = assistant("a3", tool("ag"), tool("r1"), tool("q"));
    const shown = foldToolRuns([a1, user, a2, a3], TOOLS);
    expect(shown.get(a1)).toEqual([tool("b1")]);
    expect(shown.get(a2)).toEqual([tool("b2")]);
    expect(shown.get(a3)).toEqual([tool("ag"), tool("r1"), tool("q")]);
  });
});

describe("tallyRun", () => {
  test("counts calls by kind, a file read or edited once however often", () => {
    const tally = tallyRun([
      TOOLS.b1,
      { ...TOOLS.b2, status: "error" },
      TOOLS.r1,
      call("r2", "Read", { file_path: "/p/a.ts" }),
      call("e1", "Edit", { file_path: "/p/a.ts" }),
      call("e2", "Write", { file_path: "/p/b.ts" }),
      call("g", "Grep", { pattern: "x" }),
      { ...call("w", "WebFetch", { url: "u" }), status: "denied" },
      undefined,
    ]);
    expect(tally).toEqual({
      commands: 2,
      reads: 1,
      edits: 2,
      searches: 1,
      others: 2,
      failed: 1,
      denied: 1,
    });
  });
});

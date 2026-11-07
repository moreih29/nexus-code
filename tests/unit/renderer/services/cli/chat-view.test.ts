/**
 * A Claude or Codex tab as the nexus CLI tells it: where its conversation
 * stands, and its last messages.
 */
import { describe, expect, it } from "bun:test";
import type { ChatModel, PermissionRequest } from "../../../../../src/renderer/services/chat/model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { type ChatTabState, emptyTabState } from "../../../../../src/renderer/services/chat/store";
import {
  chatEntriesOf,
  chatInfoOf,
  chatToolOf,
} from "../../../../../src/renderer/services/cli/chat-view";

function chat(model: Partial<ChatModel>, rest: Partial<ChatTabState> = {}): ChatTabState {
  return { ...emptyTabState(), phase: "ready", model: { ...emptyModel(), ...model }, ...rest };
}

const conversation: Partial<ChatModel> = {
  items: [
    { kind: "user", key: "u1", text: "Fix the login", images: [], state: "taken" },
    {
      kind: "assistant",
      key: "a1",
      messageId: "m1",
      blocks: [
        { type: "thinking", text: "hmm" },
        { type: "text", text: "Looking at the router." },
        { type: "tool", toolUseId: "t1" },
        { type: "tool", toolUseId: "t2" },
        { type: "text", text: "Fixed it." },
      ],
    },
    { kind: "notice", key: "n1", code: "interrupted" },
  ],
  tools: {
    t1: {
      id: "t1",
      name: "Bash",
      input: { command: "npm test" },
      status: "error",
      result: { text: "1 failing", isError: true, images: [] },
      parentToolUseId: null,
    },
    t2: {
      id: "t2",
      name: "Read",
      input: { file_path: "/w/app/src/router.ts" },
      status: "done",
      parentToolUseId: "agent-1",
    },
  },
};

const permission = (toolName: string, input: Record<string, unknown>): PermissionRequest => ({
  requestId: "r1",
  toolName,
  input,
  suggestions: [],
});

describe("chatInfoOf", () => {
  it("is idle after a turn, with its last answer", () => {
    expect(chatInfoOf("claude", chat(conversation), false)).toEqual({
      agent: "claude",
      state: "idle",
      message: "Looking at the router.\n\nFixed it.",
    });
  });

  it("works while a turn runs, the program starts, or a message sent is not shown yet", () => {
    expect(chatInfoOf("codex", chat({ running: true }), false).state).toBe("working");
    expect(chatInfoOf("codex", chat({}, { phase: "starting" }), false).state).toBe("working");
    expect(chatInfoOf("claude", chat({}), true).state).toBe("working");
    expect(chatInfoOf("claude", undefined, true).state).toBe("working");
    expect(chatInfoOf("claude", undefined, false).state).toBe("idle");
  });

  it("asks the user for a tool, a question or a plan, over working", () => {
    const tool = chat({
      running: true,
      permissions: [permission("Bash", { command: "rm -rf dist" })],
    });
    expect(chatInfoOf("claude", tool, false)).toEqual({
      agent: "claude",
      state: "asking",
      message: "asks to run Bash rm -rf dist",
      request: { id: "r1", tool: "Bash", input: "rm -rf dist" },
    });
    const question = chat({
      permissions: [permission("AskUserQuestion", { questions: [{ question: "Which port?" }] })],
    });
    expect(chatInfoOf("claude", question, false).message).toBe("asks: Which port?");
    expect(chatInfoOf("claude", question, false).request).toBeUndefined();
  });

  it("tells a request whole: a command's every line, another tool's input", () => {
    const command = chat({
      permissions: [permission("Bash", { command: "echo hi\ntouch made.txt" })],
    });
    const info = chatInfoOf("claude", command, false);
    expect(info.message).toBe("asks to run Bash echo hi");
    expect(info.request?.input).toBe("echo hi\ntouch made.txt");
    const write = chat({
      permissions: [permission("Write", { file_path: "/w/a.txt", content: "x" })],
    });
    expect(chatInfoOf("claude", write, false).request?.input).toBe(
      JSON.stringify({ file_path: "/w/a.txt", content: "x" }, null, 2),
    );
  });

  it("stops on an error: a program that cannot start, or a turn that failed", () => {
    expect(chatInfoOf("codex", chat({}, { phase: "not-found" }), false)).toEqual({
      agent: "codex",
      state: "error",
      message: "codex was not found where the workspace runs",
    });
    const failed = chat({
      items: [
        { kind: "user", key: "u1", text: "go", images: [], state: "taken" },
        { kind: "notice", key: "n1", code: "error", detail: "API Error: 529 overloaded" },
      ],
      lastResult: { subtype: "error_during_execution", isError: true },
    });
    expect(chatInfoOf("claude", failed, false)).toEqual({
      agent: "claude",
      state: "error",
      message: "API Error: 529 overloaded",
    });
  });
});

describe("chatEntriesOf", () => {
  it("tells what was said and the main thread's tools in order, each in its place", () => {
    // Thinking is left out; the subagent's call (#3) keeps its place, hidden.
    expect(chatEntriesOf(chat(conversation), { messages: 10 }).entries).toEqual([
      { i: 0, role: "user", text: "Fix the login" },
      { i: 1, role: "agent", text: "Looking at the router." },
      {
        i: 2,
        role: "tool",
        text: "Bash npm test (failed)",
        toolUseId: "t1",
        status: "error",
      },
      { i: 4, role: "agent", text: "Fixed it." },
      { i: 5, role: "notice", text: "interrupted" },
    ]);
  });

  it("shows the subagents' calls when asked, and reads on after a place", () => {
    const all = chatEntriesOf(chat(conversation), { subagents: true }).entries;
    expect(all[3]).toEqual({
      i: 3,
      role: "tool",
      text: "Read router.ts",
      toolUseId: "t2",
      status: "done",
      parentToolUseId: "agent-1",
    });
    expect(chatEntriesOf(chat(conversation), { since: 2 }).entries.map((e) => e.i)).toEqual([4, 5]);
    expect(chatEntriesOf(chat(conversation), { since: 5 })).toEqual({ entries: [], end: 5 });
  });

  it("reads a conversation that now ends before the place from its start", () => {
    // Cleared or rewound: what was #5 is gone, and a loop reading on would miss the rest.
    const cleared = chat({
      items: [{ kind: "user", key: "u9", text: "start over", images: [], state: "taken" }],
    });
    expect(chatEntriesOf(cleared, { since: 5 })).toEqual({
      entries: [{ i: 0, role: "user", text: "start over" }],
      end: 0,
    });
    expect(chatEntriesOf(cleared, { since: 0 }).entries).toEqual([]);
  });

  it("keeps the last messages, the history before the program's log first", () => {
    const history = { ...emptyModel(), items: [conversation.items?.[0]] } as ChatModel;
    const resumed = chat(
      { items: [{ kind: "user", key: "u2", text: "and the docs", images: [], state: "taken" }] },
      { history },
    );
    expect(chatEntriesOf(resumed).entries.map((e) => [e.i, e.text])).toEqual([
      [0, "Fix the login"],
      [1, "and the docs"],
    ]);
    expect(chatEntriesOf(chat(conversation), { messages: 2 }).entries.map((e) => e.role)).toEqual([
      "agent",
      "notice",
    ]);
    expect(chatEntriesOf(undefined, { messages: 5 })).toEqual({ entries: [], end: -1 });
  });
});

describe("chatToolOf", () => {
  it("gives a call whole by its place or its id, a subagent's too", () => {
    expect(chatToolOf(chat(conversation), "2")).toEqual({
      i: 2,
      toolUseId: "t1",
      name: "Bash",
      status: "error",
      input: { command: "npm test" },
      result: { text: "1 failing", isError: true },
    });
    expect(chatToolOf(chat(conversation), "t2")).toMatchObject({
      i: 3,
      name: "Read",
      parentToolUseId: "agent-1",
    });
  });

  it("is null for a place that is no tool call, an unknown id, or no tab", () => {
    expect(chatToolOf(chat(conversation), "1")).toBeNull();
    expect(chatToolOf(chat(conversation), "t9")).toBeNull();
    expect(chatToolOf(undefined, "2")).toBeNull();
  });
});

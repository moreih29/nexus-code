/**
 * A Claude or Codex tab as the nexus CLI tells it: where its conversation
 * stands, and its last messages.
 */
import { describe, expect, it } from "bun:test";
import type { ChatModel, PermissionRequest } from "../../../../../src/renderer/services/chat/model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { type ChatTabState, emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { chatEntriesOf, chatInfoOf } from "../../../../../src/renderer/services/cli/chat-view";

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
    });
    const question = chat({
      permissions: [permission("AskUserQuestion", { questions: [{ question: "Which port?" }] })],
    });
    expect(chatInfoOf("claude", question, false).message).toBe("asks: Which port?");
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
  it("tells what was said and the main thread's tools in order, thinking left out", () => {
    expect(chatEntriesOf(chat(conversation), 10)).toEqual([
      { role: "user", text: "Fix the login" },
      { role: "agent", text: "Looking at the router." },
      { role: "tool", text: "Bash npm test (failed)" },
      { role: "agent", text: "Fixed it." },
      { role: "notice", text: "interrupted" },
    ]);
  });

  it("keeps the last messages, the history before the program's log first", () => {
    const history = { ...emptyModel(), items: [conversation.items?.[0]] } as ChatModel;
    const resumed = chat(
      { items: [{ kind: "user", key: "u2", text: "and the docs", images: [], state: "taken" }] },
      { history },
    );
    expect(chatEntriesOf(resumed, 10).map((e) => e.text)).toEqual([
      "Fix the login",
      "and the docs",
    ]);
    expect(chatEntriesOf(chat(conversation), 2).map((e) => e.role)).toEqual(["agent", "notice"]);
    expect(chatEntriesOf(undefined, 5)).toEqual([]);
  });
});

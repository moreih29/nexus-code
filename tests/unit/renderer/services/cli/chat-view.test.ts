/**
 * A Claude or Codex tab as the nexus CLI tells it: where its conversation
 * stands, and its last messages.
 */
import { describe, expect, it, test } from "bun:test";
import {
  applyCodexLine,
  type CodexModel,
  emptyCodexModel,
} from "../../../../../src/renderer/services/chat/codex-model";
import type {
  ChatLine,
  ChatModel,
  PermissionRequest,
} from "../../../../../src/renderer/services/chat/model";
import { applyLine, emptyModel } from "../../../../../src/renderer/services/chat/model";
import { type ChatTabState, emptyTabState } from "../../../../../src/renderer/services/chat/store";
import {
  chatEntriesOf,
  chatInfoOf,
  chatItemIndexOf,
  chatSubmissionInfo,
  chatToolOf,
  pageEntriesOf,
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

test.each([
  "claude",
  "codex",
] as const)("a %s wait follows the submitted turn past older and newer questions", (agent) => {
  let seq = 0;
  let model = agent === "claude" ? emptyModel() : emptyCodexModel();
  const wire = (dir: ChatLine["dir"], message: Record<string, unknown>) => {
    const line = { dir, seq: ++seq, message } as ChatLine;
    model = agent === "claude" ? applyLine(model, line) : applyCodexLine(model as CodexModel, line);
  };
  const ask = permission("AskUserQuestion", { questions: [{ question: "Which port?" }] });
  const waiting = () =>
    chatSubmissionInfo(agent, chat({ ...model, permissions: [ask] }), "receipt");
  wire("sys", { event: "start" });
  if (agent === "claude") {
    wire("in", { type: "user", uuid: "older", message: { content: "older" } });
    wire("in", { type: "user", uuid: "receipt", message: { content: "wanted" } });
    const echo = (uuid: string) =>
      wire("out", { type: "user", isReplay: true, uuid, message: { content: "echo" } });
    echo("unrelated");
    expect(waiting().state).toBe("working");
    wire("out", { type: "result", subtype: "success" });
    echo("receipt");
    expect(waiting().state).toBe("asking");
    wire("out", {
      type: "assistant",
      message: { id: "a1", content: [{ type: "text", text: "wanted answer" }] },
    });
    wire("out", { type: "result", subtype: "success" });
    echo("newer");
  } else {
    wire("out", { method: "turn/started", params: { turn: { id: "older" } } });
    expect(waiting().state).toBe("working");
    wire("out", {
      method: "turn/completed",
      params: { turn: { id: "older", status: "completed" } },
    });
    wire("in", { id: 10, method: "turn/start", params: { clientUserMessageId: "peer-receipt" } });
    wire("out", { id: 10, result: { turn: { id: "wanted" } } });
    expect(waiting().state).toBe("asking");
    wire("out", {
      method: "item/completed",
      params: { turnId: "wanted", item: { id: "a1", type: "agentMessage", text: "wanted answer" } },
    });
    wire("out", {
      method: "turn/completed",
      params: { turn: { id: "wanted", status: "completed" } },
    });
    wire("out", { method: "turn/started", params: { turn: { id: "newer" } } });
  }
  expect(waiting()).toEqual({ agent, state: "idle", message: "wanted answer" });
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
      waiting: { kind: "permission", text: "Bash rm -rf dist" },
    });
    const question = chat({
      permissions: [permission("AskUserQuestion", { questions: [{ question: "Which port?" }] })],
    });
    expect(chatInfoOf("claude", question, false).message).toBe("asks: Which port?");
    expect(chatInfoOf("claude", question, false).request).toBeUndefined();
    expect(chatInfoOf("claude", question, false).waiting).toEqual({
      kind: "question",
      text: "Which port?",
    });
    const plan = chat({
      permissions: [permission("ExitPlanMode", { plan: "Step one\nStep two" })],
    });
    expect(chatInfoOf("claude", plan, false).waiting).toEqual({ kind: "plan", text: "Step one" });
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

describe("chatItemIndexOf", () => {
  it("finds the item each entry is part of, and marks a message the agent has not read", () => {
    const sent = {
      kind: "user" as const,
      key: "u2",
      text: "Also the logout",
      images: [],
      state: "sent" as const,
      queued: true,
    };
    const tab = chat({ ...conversation, items: [...(conversation.items ?? []), sent] });
    // #0 the message, #1–#4 the answer (text, two calls, text), #5 the notice, #6 the new message.
    expect([0, 1, 3, 4, 5, 6, 7].map((i) => chatItemIndexOf(tab, i))).toEqual([
      0,
      1,
      1,
      1,
      2,
      3,
      null,
    ]);
    const last = chatEntriesOf(tab, { subagents: true }).entries.at(-1);
    expect(last).toEqual({ i: 6, role: "user", text: "Also the logout", status: "unread" });
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

describe("what the tab keeps beside its conversation", () => {
  const relayed = {
    items: [
      {
        kind: "user",
        key: "u1",
        uuid: "uuid-1",
        text: '[nexus] The "Plan" tab (Claude) sent this, not the user. Your answer here is what it reads.\n\nRun the tests.',
        images: [],
        state: "taken",
      },
      { kind: "assistant", key: "a1", uuid: "uuid-2", blocks: [{ type: "text", text: "Green." }] },
      { kind: "user", key: "u2", uuid: "uuid-3", text: "Thanks", images: [], state: "taken" },
    ],
  } as Partial<ChatModel>;
  const from = {
    kind: "tab",
    agent: "claude",
    name: "Plan",
    workspaceId: "ws",
    tabId: "t1",
  } as const;

  it("tells a message another agent sent as its, and where the conversation moved", () => {
    const { entries } = chatEntriesOf(chat(relayed), {
      relayed: [{ id: "uuid-1", from, at: 1 }],
      moves: [{ after: "uuid-2", profile: "Work" }],
    });
    expect(entries).toEqual([
      { i: 0, role: "notice", text: 'from tab "Plan": Run the tests.', from },
      { i: 1, role: "agent", text: "Green." },
      { i: 2, role: "notice", text: 'went on in profile "Work"' },
      { i: 3, role: "user", text: "Thanks" },
    ]);
  });

  it("tells the goal the tab shows, and none once its bar was closed", () => {
    const goal = {
      condition: "All tests pass",
      status: "met",
      checks: [],
      reason: "green",
      setAt: 1,
      endedLive: true,
    } as const;
    const shown = chatInfoOf("claude", chat({ goal } as Partial<ChatModel>), false);
    expect(shown.goal).toEqual({ objective: "All tests pass", status: "met", reason: "green" });
    const closed = chat({ goal } as Partial<ChatModel>, { goalClosed: "claude|1|All tests pass" });
    expect(chatInfoOf("claude", closed, false).goal).toBeUndefined();
  });
});

describe("pageEntriesOf", () => {
  it("tells another device's chat page as chat read does, numbered by its items' places there", () => {
    const page = {
      status: {
        agent: "claude",
        title: "Review",
        running: false,
        process: "running",
        turn: null,
        streaming: null,
        permissions: [],
      },
      start: 40,
      total: 44,
      items: [
        { kind: "user", key: "u1", text: "Review it", images: [], state: "taken" },
        {
          kind: "assistant",
          key: "a1",
          messageId: "m1",
          blocks: [
            { type: "text", text: "Reading." },
            { type: "tool", toolUseId: "t1" },
            { type: "tool", toolUseId: "t2" },
          ],
        },
        { kind: "future", key: "f1" },
        {
          kind: "received",
          key: "r1",
          from: { kind: "tab", name: "Fix build", device: { id: "d1", name: "MacBook" } },
          text: "Done?",
        },
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
          input: { file_path: "/x/a.ts" },
          status: "done",
          parentToolUseId: "agent-1",
        },
      },
      tasks: {},
      agentItems: {},
    } as const;
    const entries = pageEntriesOf(page as never);
    expect(entries).toEqual([
      { i: 40, role: "user", text: "Review it" },
      { i: 41, role: "agent", text: "Reading." },
      { i: 41, role: "tool", text: "Bash npm test (failed)", toolUseId: "t1", status: "error" },
      {
        i: 43,
        role: "notice",
        text: 'from tab "Fix build" on "MacBook": Done?',
        from: { kind: "tab", name: "Fix build", device: { id: "d1", name: "MacBook" } },
      },
    ]);
    expect(
      pageEntriesOf(page as never, true)
        .map((e) => e.toolUseId)
        .filter(Boolean),
    ).toEqual(["t1", "t2"]);
  });
});

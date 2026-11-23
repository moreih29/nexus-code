/**
 * A chat's last turns at a glance (chat.peek), as an open tab's
 * conversation and the end of a history each give them.
 */
import { describe, expect, test } from "bun:test";
import {
  ChatPeekSchema,
  MAX_PEEK_BYTES,
  MAX_PEEK_REPLY,
  MAX_PEEK_USER_TEXT,
} from "../../../../../packages/remote-protocol/src";
import type {
  ChatItem,
  ChatModel,
  ToolCall,
} from "../../../../../src/renderer/services/chat/model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import {
  ClaudeTail,
  PEEK_MORE_PAGES,
  peekOfChat,
  peekOfRollout,
  peekTurnsOf,
} from "../../../../../src/renderer/services/remote/chat-peek";
import { type RelayedMessage, relayedText } from "../../../../../src/shared/chat/relay";
import type { RolloutEvent, TranscriptPageResult } from "../../../../../src/shared/ipc/contract";

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const user = (key: string, text = key, over: Partial<ChatItem> = {}): ChatItem =>
  ({ kind: "user", key, uuid: key, text, images: [], state: "taken", ...over }) as ChatItem;
const said = (key: string, text: string, ...tools: string[]): ChatItem => ({
  kind: "assistant",
  key,
  messageId: `m-${key}`,
  blocks: [
    { type: "thinking", text: "hm" },
    ...(text ? [{ type: "text" as const, text }] : []),
    ...tools.map((id) => ({ type: "tool" as const, toolUseId: id })),
  ],
});
const tool = (id: string, name: string, parentToolUseId: string | null = null): ToolCall => ({
  id,
  name,
  input: {},
  status: "done",
  parentToolUseId,
});
const tools = (...calls: ToolCall[]) => Object.fromEntries(calls.map((call) => [call.id, call]));

function source(
  model: Partial<ChatModel>,
  over: { history?: Partial<ChatModel>; relayed?: RelayedMessage[]; chat?: object } = {},
) {
  return {
    agent: "claude" as const,
    title: "Fix the build",
    chat: {
      ...emptyTabState(),
      phase: "ready" as const,
      model: { ...emptyModel(), ...model },
      history: over.history ? { ...emptyModel(), ...over.history } : null,
      ...over.chat,
    },
    ...(over.relayed ? { relayed: over.relayed } : {}),
  };
}

const sender = {
  kind: "tab",
  agent: "claude",
  name: "Lead",
  workspaceId: "w",
  tabId: "t",
} as const;

describe("the turns of a conversation", () => {
  test("each begins at a message: the last words with text, and the main thread's calls counted", () => {
    const turns = peekTurnsOf(
      [
        user("u1", 'Fix it\n\n@src/a.ts @"my file.ts"', {
          images: [{ mediaType: "image/png", data: "" }],
        } as Partial<ChatItem>),
        said("a1", "Looking.", "t1", "t2"),
        said("a2", "", "t3", "sub"),
        { kind: "notice", key: "n1", code: "compacted" } as ChatItem,
        said("a3", "Fixed."),
        said("a4", "", "t4"),
        user("u2", "Thanks"),
      ],
      tools(
        tool("t1", "Bash"),
        tool("t2", "Read"),
        tool("t3", "Bash"),
        tool("sub", "Grep", "t3"),
        tool("t4", "Edit"),
      ),
    );
    expect(turns).toEqual([
      {
        user: { text: "Fix it", images: 1, files: 2 },
        reply: "Fixed.",
        tools: { Bash: 2, Read: 1, Edit: 1 },
      },
      { user: { text: "Thanks", images: 0 }, reply: "", tools: {} },
    ]);
  });

  test("what the agent wrote before the first message there is a turn with neither", () => {
    const turns = peekTurnsOf([said("a0", "Earlier."), user("u1"), said("a1", "Later.")], {});
    expect(turns).toEqual([
      { reply: "Earlier.", tools: {} },
      { user: { text: "u1", images: 0 }, reply: "Later.", tools: {} },
    ]);
  });

  test("a message waiting for the agent to read it began no turn yet", () => {
    const turns = peekTurnsOf(
      [
        user("u1"),
        said("a1", "Working."),
        user("u2", "And this", { state: "sent", queued: true } as Partial<ChatItem>),
        said("a2", "Still working."),
      ],
      {},
    );
    expect(turns).toEqual([
      { user: { text: "u1", images: 0 }, reply: "Still working.", tools: {} },
    ]);
  });
});

describe("an open tab's peek", () => {
  test("tells where it stands, the reply being written and what it waits on", () => {
    const peek = peekOfChat(
      source({
        items: [user("u1", "Go"), said("a1", "On it.", "t1")],
        tools: tools(tool("t1", "Bash")),
        running: true,
        streaming: {
          messageId: "m",
          blocks: {
            1: { type: "text", text: "second" },
            0: { type: "text", text: "first" },
            2: { type: "thinking", text: "hidden" },
            3: { type: "tool_use", text: "{}", toolUseId: "t9" },
          },
        },
        permissions: [{ requestId: "r1", toolName: "Bash", input: {}, suggestions: [] }],
      }),
    );
    expect(peek).toEqual({
      status: { running: true, phase: "ready", streaming: "first\n\nsecond" },
      turns: [{ user: { text: "Go", images: 0 }, reply: "On it.", tools: { Bash: 1 } }],
      waiting: { kind: "permission", tool: "Bash" },
    });
    expect(ChatPeekSchema.safeParse(peek).success).toBe(true);
  });

  test.each([
    ["AskUserQuestion", { kind: "question" }],
    ["ExitPlanMode", { kind: "plan" }],
  ] as const)("waiting on %s", (toolName, waiting) => {
    const peek = peekOfChat(
      source({ permissions: [{ requestId: "r", toolName, input: {}, suggestions: [] }] }),
    );
    expect(peek.waiting).toEqual(waiting);
  });

  test("gives the last turns asked for, three unless told, five at most, with more", () => {
    const items = Array.from({ length: 7 }, (_, i) => [
      user(`u${i}`),
      said(`a${i}`, `r${i}`),
    ]).flat();
    const replies = (turns?: number) =>
      peekOfChat(source({ items }), turns).turns.map((t) => t.reply);
    expect(replies()).toEqual(["r4", "r5", "r6"]);
    expect(replies(1)).toEqual(["r6"]);
    expect(replies(9)).toEqual(["r2", "r3", "r4", "r5", "r6"]);
    expect(peekOfChat(source({ items })).more).toBe(true);
    expect(peekOfChat(source({ items: items.slice(0, 4) })).more).toBeUndefined();
    // Its history has pages not read yet: more, though all it holds was sent.
    expect(
      peekOfChat(
        source(
          { items: items.slice(0, 2) },
          { chat: { historyPage: { hasEarlier: true, loading: false } } },
        ),
      ).more,
    ).toBe(true);
  });

  test("its history comes before its program's log", () => {
    const peek = peekOfChat(
      source(
        { items: [user("u2", "now"), said("a2", "Now.")] },
        { history: { items: [user("u1", "before"), said("a1", "Before.")] } },
      ),
    );
    expect(peek.turns.map((t) => [t.user?.text, t.reply])).toEqual([
      ["before", "Before."],
      ["now", "Now."],
    ]);
  });

  test("a message another agent sent is received from it, never the user's", () => {
    const relayed: RelayedMessage[] = [{ id: "u1", from: sender, at: 1 }];
    const text = relayedText(sender, "Do the thing");
    const peek = peekOfChat(
      source(
        {
          items: [
            user("u1", text),
            said("a1", "Done."),
            // One whose record the tab no longer keeps: told by the line before it.
            user("u2", relayedText({ ...sender, name: 'The "B" tab' }, "Again")),
            said("a2", "Again done."),
            user("u3", relayedText({ kind: "manager" }, "And you")),
          ],
        },
        { relayed },
      ),
    );
    expect(peek.turns).toEqual([
      { received: { from: "Lead", text: "Do the thing" }, reply: "Done.", tools: {} },
      { received: { from: 'The "B" tab', text: "Again" }, reply: "Again done.", tools: {} },
      { received: { from: "manager", text: "And you" }, reply: "", tools: {} },
    ]);
    expect(JSON.stringify(peek)).not.toContain("[nexus]");
  });

  test("long Korean turns are fitted in the budget: the oldest left out, with more", () => {
    const items = [1, 2, 3].flatMap((i) => [
      user(`u${i}`, "가".repeat(3000)),
      said(`a${i}`, "나".repeat(9000)),
    ]);
    const peek = peekOfChat(source({ items }));
    expect(bytesOf(peek)).toBeLessThanOrEqual(MAX_PEEK_BYTES);
    expect(peek.turns).toHaveLength(1);
    expect(peek.more).toBe(true);
    expect(Array.from(peek.turns[0].user?.text ?? "")).toHaveLength(MAX_PEEK_USER_TEXT);
    expect(Array.from(peek.turns[0].reply)).toHaveLength(MAX_PEEK_REPLY);
    expect(peek.turns[0].reply.endsWith("…")).toBe(true);
    expect(ChatPeekSchema.safeParse(peek).success).toBe(true);
  });
});

describe("a Codex thread's peek, from the end of its rollout", () => {
  const events: RolloutEvent[] = [
    { kind: "turn", turnId: "t1" },
    { kind: "user", text: "Build it", images: 2 },
    { kind: "tool", tool: "commandExecution" },
    { kind: "tool", tool: "fileChange", changes: ["add", "update", "delete"] },
    { kind: "tool", tool: "mcpToolCall", server: "docs", name: "search" },
    { kind: "tool", tool: "webSearch" },
    { kind: "tool", tool: "imageView" },
    { kind: "tool", tool: "dynamicToolCall", name: "lookup" },
    { kind: "tool", tool: "commandExecution" },
    { kind: "agent", text: "Building." },
    { kind: "agent", text: "Built." },
    { kind: "turn", turnId: "t2" },
    { kind: "user", turnId: "t2", clientId: "c2", text: relayedText(sender, "Check it") },
    { kind: "agent", turnId: "t2", text: "Checked." },
  ];

  test("its calls are named as the tab names them", () => {
    const peek = peekOfRollout({ found: true, events, more: true }, [
      { id: "gone", turnId: "t2", from: sender, at: 1 },
    ]);
    expect(peek).toEqual({
      status: { running: false, phase: "idle" },
      more: true,
      turns: [
        {
          user: { text: "Build it", images: 2 },
          reply: "Built.",
          tools: {
            Bash: 2,
            Write: 1,
            Edit: 1,
            Delete: 1,
            mcp__docs__search: 1,
            WebSearch: 1,
            ViewImage: 1,
            lookup: 1,
          },
        },
        { received: { from: "Lead", text: "Check it" }, reply: "Checked.", tools: {} },
      ],
    });
    expect(ChatPeekSchema.safeParse(peek).success).toBe(true);
  });

  test("a relayed message is found by the id it was sent with too, or by its line", () => {
    const byId = peekOfRollout({ found: true, events }, [{ id: "c2", from: sender, at: 1 }]);
    expect(byId.turns[1].received).toEqual({ from: "Lead", text: "Check it" });
    expect(byId.more).toBeUndefined();
    const byLine = peekOfRollout({ found: true, events }, undefined);
    expect(byLine.turns[1].received).toEqual({ from: "Lead", text: "Check it" });
  });

  test("a thread with no rollout is missing", () => {
    expect(peekOfRollout({ found: false, events: [] }, undefined)).toEqual({
      status: { running: false, phase: "idle" },
      turns: [],
      unavailable: "missing",
    });
  });
});

describe("a Claude session's peek, from the end of its transcript", () => {
  const turn = (n: number, text = `q${n}`) => [
    { type: "user", uuid: `u${n}`, message: { role: "user", content: text } },
    {
      type: "assistant",
      uuid: `a${n}`,
      message: {
        id: `m${n}`,
        role: "assistant",
        content: [
          { type: "text", text: `r${n}` },
          { type: "tool_use", id: `t${n}`, name: "Read", input: { file_path: "/p/a" } },
        ],
      },
    },
    {
      type: "user",
      uuid: `tr${n}`,
      message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "file body" }] },
    },
    {
      type: "assistant",
      uuid: `b${n}`,
      message: { id: `n${n}`, role: "assistant", content: [{ type: "text", text: `done ${n}` }] },
    },
  ];
  const page = (lines: unknown[], from: number, over: Partial<TranscriptPageResult> = {}) => ({
    found: true,
    truncated: false,
    snapshot: "snap",
    lines,
    positions: lines.map((_, i) => from + i),
    ...over,
  });

  test("reads the last turns of a page, no tool result sent", () => {
    const lines = [1, 2, 3, 4].flatMap((n) => turn(n));
    const tail = new ClaudeTail(page(lines, 100, { cursor: "c1" }));
    expect(tail.cursor).toBeUndefined();
    const peek = tail.peek(undefined, 2);
    expect(peek).toEqual({
      status: { running: false, phase: "idle" },
      more: true,
      turns: [3, 4].map((n) => ({
        user: { text: `q${n}`, images: 0 },
        reply: `done ${n}`,
        tools: { Read: 1 },
      })),
    });
    expect(JSON.stringify(peek)).not.toContain("file body");
    expect(ChatPeekSchema.safeParse(peek).success).toBe(true);
  });

  test("an agent's page without a snapshot reads the same, and all of a short one is not more", () => {
    const tail = new ClaudeTail({ found: true, truncated: false, lines: turn(1) });
    expect(tail.peek(undefined)).toEqual({
      status: { running: false, phase: "idle" },
      turns: [{ user: { text: "q1", images: 0 }, reply: "done 1", tools: { Read: 1 } }],
    });
  });

  test("a relayed message is received, by the record of its id", () => {
    const lines = turn(1, relayedText(sender, "Review this"));
    const peek = new ClaudeTail(page(lines, 0)).peek([{ id: "u1", from: sender, at: 1 }]);
    expect(peek.turns[0].received).toEqual({ from: "Lead", text: "Review this" });
    expect(peek.turns[0].user).toBeUndefined();
  });

  test("a page with no message that began a turn asks for the one before, a few times", () => {
    const [question, ...rest] = turn(1);
    const tail = new ClaudeTail(page(rest, 10, { cursor: "c1" }));
    expect(tail.cursor).toBe("c1");
    tail.prepend(page([question], 5, { cursor: "c0" }));
    expect(tail.cursor).toBeUndefined();
    expect(tail.peek(undefined).turns).toEqual([
      { user: { text: "q1", images: 0 }, reply: "done 1", tools: { Read: 1 } },
    ]);
    expect(tail.peek(undefined).more).toBe(true);

    // Never more than PEEK_MORE_PAGES: what was read is told, cut at its start.
    const long = new ClaudeTail(page([rest[2]], 100, { cursor: "c100" }));
    for (let i = 1; i <= PEEK_MORE_PAGES; i++) {
      expect(long.cursor).toBe(`c${101 - i}`);
      long.prepend(page([rest[0]], 100 - i, { cursor: `c${100 - i}` }));
    }
    expect(long.cursor).toBeUndefined();
    const cut = long.peek(undefined);
    expect(cut.more).toBe(true);
    expect(cut.turns).toHaveLength(1);
    expect(cut.turns[0].user).toBeUndefined();
  });

  test("a session with no transcript is missing", () => {
    const peek = new ClaudeTail({ found: false, truncated: false, lines: [] }).peek(undefined);
    expect(peek.unavailable).toBe("missing");
    expect(peek.turns).toEqual([]);
  });
});

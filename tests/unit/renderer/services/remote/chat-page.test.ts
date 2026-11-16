/** A chat as another device reads it: trimmed, paged, with the calls its items name. */
import { describe, expect, test } from "bun:test";
import { ChatPageSchema } from "../../../../../packages/remote-protocol/src";
import type {
  ChatItem,
  ChatModel,
  ToolCall,
} from "../../../../../src/renderer/services/chat/model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { scopesOf } from "../../../../../src/renderer/services/chat/permission-scopes";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { chatPageOf, conversationOf } from "../../../../../src/renderer/services/remote/chat-page";

const user = (key: string, text = key): ChatItem => ({
  kind: "user",
  key,
  uuid: `u-${key}`,
  sentUuid: `s-${key}`,
  text,
  images: [],
  state: "taken",
});
const said = (key: string, ...tools: string[]): ChatItem => ({
  kind: "assistant",
  key,
  messageId: `m-${key}`,
  uuid: `u-${key}`,
  blocks: [
    { type: "text", text: key },
    ...tools.map((id) => ({ type: "tool" as const, toolUseId: id })),
  ],
});
const tool = (id: string, over: Partial<ToolCall> = {}): ToolCall => ({
  id,
  name: "Bash",
  input: { command: "ls" },
  status: "done",
  parentToolUseId: null,
  ...over,
});

function source(model: Partial<ChatModel>, history?: Partial<ChatModel>) {
  return {
    agent: "claude" as const,
    title: "Fix the build",
    chat: {
      ...emptyTabState(),
      model: { ...emptyModel(), ...model },
      history: history ? { ...emptyModel(), ...history } : null,
    },
  };
}

describe("a chat's page for another device", () => {
  test("gives the last items, its history first, and what only this app uses is left out", () => {
    const page = chatPageOf(
      source(
        { items: [user("b"), said("c", "t2")], tools: { t2: tool("t2", { partialInput: "{" }) } },
        { items: [user("a"), said("a2", "t1")], tools: { t1: tool("t1") } },
      ),
    );
    expect(ChatPageSchema.safeParse(page).success).toBe(true);
    expect(page.total).toBe(4);
    expect(page.start).toBe(0);
    expect(page.items.map((i) => i.key)).toEqual(["h-a", "h-a2", "b", "c"]);
    expect(page.items[0]).toEqual({
      kind: "user",
      key: "h-a",
      text: "a",
      images: [],
      state: "taken",
    });
    expect(Object.keys(page.tools).sort()).toEqual(["t1", "t2"]);
    expect(page.tools.t2).not.toHaveProperty("partialInput");
    expect(page.status).toMatchObject({ agent: "claude", title: "Fix the build", running: false });
  });

  test("keys the history apart from a resumed program's log, which numbers its lines again", () => {
    const chat = source(
      { items: [user("u1"), said("a3", "t2")], tools: { t2: tool("t2") } },
      { items: [user("u1"), said("a3", "t1")], tools: { t1: tool("t1") } },
    );
    const keys = chatPageOf(chat).items.map((i) => i.key);
    expect(keys).toEqual(["h-u1", "h-a3", "u1", "a3"]);
    expect(new Set(keys).size).toBe(keys.length);
    // The same item for each read, so a watch sends only what changed.
    expect(conversationOf(chat).items[0]).toBe(conversationOf(chat).items[0]);
  });

  test("a message another agent sent shows as received in the history too", () => {
    // Codex keys a message the tab sent by its client id (u-<id>), which the record names.
    const sent: ChatItem = {
      kind: "user",
      key: "u-r1",
      text: "Run the tests.",
      images: [],
      state: "taken",
    };
    const chat = {
      ...source({ items: [said("a1")] }, { items: [sent] }),
      relayed: [{ id: "r1", from: { kind: "manager" as const }, at: 1 }],
    };
    const items = conversationOf(chat).items;
    expect(items[0]).toMatchObject({ kind: "received", key: "h-u-r1", from: { kind: "manager" } });
    expect(conversationOf(chat).items[0]).toBe(items[0]);
  });

  test("pages back by `before`, naming only its items' calls", () => {
    const items = Array.from({ length: 10 }, (_, i) => said(`i${i}`, `t${i}`));
    const tools = Object.fromEntries(items.map((_, i) => [`t${i}`, tool(`t${i}`)]));
    const last = chatPageOf(source({ items, tools }), { limit: 3 });
    expect([last.start, last.total]).toEqual([7, 10]);
    expect(Object.keys(last.tools)).toEqual(["t7", "t8", "t9"]);
    const earlier = chatPageOf(source({ items, tools }), { before: 7, limit: 3 });
    expect(earlier.items.map((i) => i.key)).toEqual(["i4", "i5", "i6"]);
    expect(chatPageOf(source({ items, tools }), { before: 2, limit: 3 }).start).toBe(0);
  });

  test("a subagent's messages come with its call, and the calls under it", () => {
    const page = chatPageOf(
      source({
        items: [said("a", "agent")],
        tools: {
          agent: tool("agent", { name: "Agent", status: "running" }),
          sub: tool("sub", { parentToolUseId: "agent" }),
          late: tool("late", { parentToolUseId: "agent", status: "streaming" }),
          other: tool("other"),
        },
        agentItems: { agent: [said("s1", "sub") as never] },
      }),
    );
    expect(Object.keys(page.tools).sort()).toEqual(["agent", "late", "sub"]);
    expect(page.agentItems.agent?.map((i) => i.key)).toEqual(["s1"]);
    expect(page.agentItems.agent?.[0]).not.toHaveProperty("uuid");
  });

  test("tells an image by its type and size, and cuts a long result", () => {
    const page = chatPageOf(
      source({
        items: [
          {
            ...(user("a") as object),
            images: [{ mediaType: "image/png", data: "aGVsbG8=" }],
          } as ChatItem,
          said("b", "t1"),
        ],
        tools: {
          t1: tool("t1", {
            result: { text: "x".repeat(70 * 1024), isError: false, images: [] },
          }),
        },
      }),
    );
    expect(page.items[0]).toMatchObject({ images: [{ mediaType: "image/png", bytes: 5 }] });
    expect(page.tools.t1?.result?.text.length).toBe(64 * 1024);
    expect(page.tools.t1?.result?.truncated).toBe(true);
  });

  test("tells where the turn stands: the reply being written, the request waiting", () => {
    const page = chatPageOf(
      source({
        running: true,
        process: "running",
        model: "claude-haiku-5-5",
        turn: { startedAt: 1, outputTokens: 12, thinkingTokens: 3 },
        streaming: {
          messageId: "m9",
          blocks: {
            1: { type: "tool_use", text: "{", toolUseId: "t9" },
            0: { type: "text", text: "Let" },
          },
        },
        tools: { t9: tool("t9", { status: "streaming" }) },
        permissions: [
          { requestId: "r1", toolName: "Bash", input: { command: "rm" }, suggestions: [{}] },
        ],
        tasks: {
          k1: {
            taskId: "k1",
            type: "local_bash",
            description: "watch",
            status: "running",
            prompt: "p",
          },
          k2: { taskId: "k2", type: "local_bash", description: "old", status: "completed" },
        },
      }),
    );
    expect(ChatPageSchema.safeParse(page).success).toBe(true);
    expect(page.status.turn).toEqual({ startedAt: 1, outputTokens: 12, thinkingTokens: 3 });
    expect(page.status.streaming?.blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(Object.keys(page.tools)).toEqual(["t9"]);
    expect(page.status.permissions[0]).not.toHaveProperty("suggestions");
    expect(Object.keys(page.tasks)).toEqual(["k1"]);
    expect(page.tasks.k1).not.toHaveProperty("prompt");
  });
});

describe("a turn stopping, or trying the API again (0.13.0)", () => {
  test("is told, and drawn as this app's chat draws it", () => {
    const page = chatPageOf(
      source({
        running: true,
        interrupting: true,
        process: "running",
        turn: {
          startedAt: 1,
          outputTokens: 0,
          thinkingTokens: 0,
          retry: { attempt: 2, maxRetries: 10, delayMs: 4000 },
        },
      }),
    );
    expect(ChatPageSchema.safeParse(page).success).toBe(true);
    expect(page.status.interrupting).toBe(true);
    expect(page.status.turn).toEqual({
      startedAt: 1,
      outputTokens: 0,
      retry: { attempt: 2, maxRetries: 10, delayMs: 4000 },
    });
    const model = modelOfPage(page);
    expect(model.interrupting).toBe(true);
    expect(model.turn?.retry).toEqual({ attempt: 2, maxRetries: 10, delayMs: 4000 });
    // Neither, when the turn goes on.
    const going = chatPageOf(source({ running: true, process: "running" }));
    expect(going.status).not.toHaveProperty("interrupting");
    expect(modelOfPage(going).interrupting).toBeUndefined();
  });
});

describe("where its tab stands with its program (0.13.0)", () => {
  test("its phase, why it failed, its version and how its program exited", () => {
    const base = source({
      process: "exited",
      version: "2.1.0",
      exit: { code: 1, stderrTail: `${"x".repeat(9000)}boom` },
    });
    const page = chatPageOf({ ...base, chat: { ...base.chat, phase: "ended", error: "gone" } });
    expect(ChatPageSchema.safeParse(page).success).toBe(true);
    expect(page.status).toMatchObject({ phase: "ended", error: "gone", version: "2.1.0" });
    expect(page.status.exit?.code).toBe(1);
    // The end of what it wrote, as much as a banner's details take.
    expect(page.status.exit?.stderrTail?.endsWith("boom")).toBe(true);
    expect(page.status.exit?.stderrTail?.length).toBe(8 * 1024);
  });
});

describe("a request's always-allow suggestions", () => {
  test("are worded, by the index chat.answer's always gives back; those it cannot word left out", () => {
    const page = chatPageOf(
      source({
        permissions: [
          {
            requestId: "r1",
            toolName: "Bash",
            input: { command: "npm test" },
            suggestions: [
              { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }] },
              { type: "unknown" },
              { type: "addDirectories", directories: ["/tmp/x"] },
            ],
          },
        ],
      }),
    );
    const suggestions = page.status.permissions[0]?.suggestions ?? [];
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toEqual({ label: "Bash(npm test:*)" });
    expect(suggestions[1]?.label).toContain("/tmp/x");
  });
});

const { modelOfPage } = await import("../../../../../src/renderer/services/remote/chat-model");

describe("a page drawn as this app's chat", () => {
  test("gives back the items, calls and turn the page told", () => {
    const page = chatPageOf(
      source({
        items: [user("a"), said("b", "t1"), { kind: "notice", key: "n", code: "interrupted" }],
        tools: { t1: tool("t1", { result: { text: "ok", isError: false, images: [] } }) },
        running: true,
        process: "running",
        turn: { startedAt: 5, outputTokens: 9, thinkingTokens: 2 },
        streaming: { messageId: "m", blocks: { 0: { type: "text", text: "Hel" } } },
        permissions: [{ requestId: "r", toolName: "Bash", input: {}, suggestions: [] }],
      }),
    );
    const model = modelOfPage(page);
    expect(model.items.map((i) => i.key)).toEqual(["a", "b", "n"]);
    expect(model.tools.t1).toMatchObject({ id: "t1", input: { command: "ls" }, status: "done" });
    expect(model.tools.t1?.result?.text).toBe("ok");
    expect(model.turn).toEqual({ startedAt: 5, outputTokens: 9, thinkingTokens: 2 });
    expect(model.streaming?.blocks[0]?.text).toBe("Hel");
    expect(model.permissions[0]).toMatchObject({ requestId: "r", suggestions: [] });
    expect(model.running).toBe(true);
  });

  test("words a request's always-allow choices as the serving computer did, to keep by index", () => {
    const page = chatPageOf(source({}));
    const model = modelOfPage({
      ...page,
      status: {
        ...page.status,
        permissions: [
          {
            requestId: "r",
            toolName: "Bash",
            input: {},
            suggestions: [{ label: "Bash(npm test:*)" }, { label: "Accept edits" }],
          },
        ],
      },
    });
    const suggestions = model.permissions[0]?.suggestions ?? [];
    expect(suggestions).toEqual([
      { type: "remote", label: "Bash(npm test:*)", index: 0 },
      { type: "remote", label: "Accept edits", index: 1 },
    ]);
    expect(scopesOf(suggestions, (key) => key).map((scope) => scope.label)).toEqual([
      "Bash(npm test:*)",
      "Accept edits",
    ]);
  });

  test("leaves out an item of a kind it does not know, and keeps an image's place to fetch it by", () => {
    const model = modelOfPage({
      ...chatPageOf(source({})),
      items: [
        {
          kind: "user",
          key: "a",
          text: "see",
          images: [{ mediaType: "image/png", bytes: 9 }],
          state: "taken",
        },
        { kind: "poll", key: "p", question: "?" },
      ],
      total: 2,
    });
    expect(model.items).toEqual([
      {
        kind: "user",
        key: "a",
        text: "see",
        images: [
          { mediaType: "image/png", data: "", remote: { kind: "user", itemKey: "a", index: 0 } },
        ],
        state: "taken",
        // Its key is its id here: a rewind or fork from it names it by it.
        uuid: "a",
      },
    ]);
  });

  test("a message's key is its id, once the program took one of the user's", () => {
    const model = modelOfPage({
      ...chatPageOf(source({})),
      items: [
        { kind: "user", key: "u1", text: "hi", images: [], state: "sent" },
        { kind: "assistant", key: "a1", blocks: [{ type: "text", text: "yo" }] },
      ],
      total: 2,
    });
    expect(model.items.map((item) => ("uuid" in item ? item.uuid : null))).toEqual([null, "a1"]);
  });

  test("an unread message of the user's is taken back by its key", () => {
    const model = modelOfPage({
      ...chatPageOf(source({})),
      items: [
        { kind: "user", key: "u1", text: "wait", images: [], state: "sent", queued: true },
        { kind: "user", key: "u2", text: "sent", images: [], state: "sent" },
      ],
      total: 2,
    });
    expect(model.items.map((item) => ("sentUuid" in item ? item.sentUuid : null))).toEqual([
      "u1",
      null,
    ]);
  });

  test("marks a result that was cut", () => {
    const page = chatPageOf(
      source({
        items: [said("b", "t1")],
        tools: {
          t1: tool("t1", { result: { text: "y".repeat(70_000), isError: false, images: [] } }),
        },
      }),
    );
    expect(modelOfPage(page).tools.t1?.result?.text.endsWith("…")).toBe(true);
  });
});

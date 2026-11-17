import { describe, expect, test } from "bun:test";
import {
  cutEntries,
  historyModel,
  joinHistory,
  modelBefore,
  modelUuids,
  sessionTitleOf,
  subagentIdOf,
  subagentLines,
  subagentLog,
  uuidBefore,
  withSubagentLog,
} from "../../../../../src/renderer/services/chat/history";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";

// A transcript's entries as Claude Code writes them: bookkeeping between
// the messages, which have uuids.
const ENTRIES = [
  { type: "session-owner" },
  { type: "user", uuid: "u1", message: { role: "user", content: "one" } },
  { type: "attachment", uuid: "x1" },
  {
    type: "assistant",
    uuid: "a1",
    message: { id: "m1", role: "assistant", content: [{ type: "text", text: "first" }] },
  },
  { type: "last-prompt" },
  { type: "user", uuid: "u2", message: { role: "user", content: "two" } },
  {
    type: "assistant",
    uuid: "a2",
    message: { id: "m2", role: "assistant", content: [{ type: "text", text: "second" }] },
  },
];

function texts(model: ReturnType<typeof historyModel>): string[] {
  return model.items.map((item) =>
    item.kind === "user"
      ? `user:${item.text}`
      : item.kind === "assistant"
        ? `assistant:${item.blocks.map((b) => (b.type === "text" ? b.text : b.type)).join("")}`
        : `notice:${item.code}`,
  );
}

describe("chat history cuts", () => {
  test("a fork's cut keeps the entries up to its message", () => {
    expect(cutEntries(ENTRIES, { upTo: "a1" })).toEqual(ENTRIES.slice(0, 4));
    expect(texts(historyModel(ENTRIES, { upTo: "a1" }))).toEqual(["user:one", "assistant:first"]);
  });

  test("a resumed log's cut stops before the messages the log shows", () => {
    const model = historyModel(ENTRIES, { before: new Set(["u2", "a2"]) });
    expect(texts(model)).toEqual(["user:one", "assistant:first"]);
  });

  test("what the CLI told the model by itself is not the user's message", () => {
    const model = historyModel([
      ...ENTRIES,
      {
        type: "user",
        uuid: "n1",
        promptSource: "system",
        origin: { kind: "task-notification" },
        message: { role: "user", content: "<task-notification>done</task-notification>" },
      },
      {
        type: "assistant",
        uuid: "a3",
        message: { id: "m3", role: "assistant", content: [{ type: "text", text: "noted" }] },
      },
    ]);
    expect(texts(model)).toEqual([
      "user:one",
      "assistant:first",
      "user:two",
      "assistant:second",
      "assistant:noted",
    ]);
  });

  test("a command the user ran reads as typed, and its output is left out", () => {
    const model = historyModel([
      {
        type: "user",
        uuid: "c0",
        message: {
          role: "user",
          content: "<command-name>/clear</command-name>\n<command-args></command-args>",
        },
      },
      {
        type: "user",
        uuid: "c1",
        message: {
          role: "user",
          content:
            "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>",
        },
      },
      {
        type: "user",
        uuid: "c2",
        message: {
          role: "user",
          content: "<local-command-stdout>Set model to haiku</local-command-stdout>",
        },
      },
      ...ENTRIES.slice(1),
    ]);
    expect(texts(model)).toEqual([
      "user:/model haiku",
      "user:one",
      "assistant:first",
      "user:two",
      "assistant:second",
    ]);
  });

  test("no cut keeps it all", () => {
    expect(texts(historyModel(ENTRIES))).toEqual([
      "user:one",
      "assistant:first",
      "user:two",
      "assistant:second",
    ]);
    expect(cutEntries(ENTRIES, { upTo: "missing" })).toEqual(ENTRIES);
  });

  test("the uuids a model shows", () => {
    expect([...modelUuids(historyModel(ENTRIES))]).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("a joined history keys anew what after has that before has already", () => {
    const before = historyModel(ENTRIES);
    const after = historyModel(ENTRIES);
    const all = joinHistory(before, after);
    const keys = all.items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.slice(before.items.length)).toEqual(before.items.map((item) => `${item.key}~2`));
    // What before has, and what after has alone, keep their keys and items.
    expect(all.items.slice(0, before.items.length)).toEqual(before.items);
    const third = joinHistory(all, after);
    expect(third.items.slice(all.items.length).map((item) => item.key)).toEqual(
      before.items.map((item) => `${item.key}~3`),
    );
  });

  test("a rewind keeps what came before the message, and forks at the one before it", () => {
    const all = joinHistory(historyModel(ENTRIES, { upTo: "a1" }), historyModel(ENTRIES.slice(5)));
    expect(texts(modelBefore(all, "u2"))).toEqual(["user:one", "assistant:first"]);
    expect(uuidBefore(all, "u2")).toBe("a1");
    expect(uuidBefore(all, "a1")).toBe("u1");
    // The first message has nothing before it: a rewind there starts over.
    expect(uuidBefore(all, "u1")).toBeUndefined();
    expect(modelBefore(all, "u1").items).toEqual([]);
  });
});

describe("sessionTitleOf", () => {
  test("is the last name a session was given", () => {
    expect(sessionTitleOf(ENTRIES)).toBeUndefined();
    expect(
      sessionTitleOf([
        { type: "custom-title", customTitle: "First name" },
        ...ENTRIES,
        { type: "custom-title", customTitle: "  Test plan " },
        { type: "custom-title", customTitle: "" },
        null,
      ]),
    ).toBe("Test plan");
  });

  test("is else the last title Claude made, a name winning over it", () => {
    const made = [
      { type: "ai-title", aiTitle: "Old title" },
      ...ENTRIES,
      { type: "ai-title", aiTitle: " Greet.ts default name " },
      { type: "ai-title", aiTitle: "" },
    ];
    expect(sessionTitleOf(made)).toBe("Greet.ts default name");
    expect(sessionTitleOf([{ type: "custom-title", customTitle: "Test plan" }, ...made])).toBe(
      "Test plan",
    );
  });
});

// A subagent's file as Claude Code 2.1 keeps it beside its session
// (subagents/agent-<id>.jsonl): its prompt, its replies and its tools'
// results, with the requests it logged between them.
const SUBAGENT = [
  {
    parentUuid: null,
    isSidechain: true,
    agentId: "a1b2",
    type: "user",
    uuid: "s1",
    timestamp: "2026-11-17T01:00:00.000Z",
    message: { role: "user", content: "Look at the payments module." },
  },
  { type: "api-request", id: "r1" },
  {
    isSidechain: true,
    agentId: "a1b2",
    type: "assistant",
    uuid: "s2",
    timestamp: "2026-11-17T01:00:05.000Z",
    message: {
      id: "m1",
      role: "assistant",
      content: [
        { type: "text", text: "Reading it." },
        { type: "tool_use", id: "read1", name: "Read", input: { file_path: "/p/pay.ts" } },
      ],
    },
  },
  { type: "attachment", attachment: { type: "todo" } },
  {
    isSidechain: true,
    agentId: "a1b2",
    type: "user",
    uuid: "s3",
    timestamp: "2026-11-17T01:00:06.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "read1", content: "1\texport {}" }],
    },
    toolUseResult: { type: "text", file: { filePath: "/p/pay.ts" } },
  },
  {
    isSidechain: true,
    agentId: "a1b2",
    type: "assistant",
    uuid: "s4",
    timestamp: "2026-11-17T01:00:09.000Z",
    message: { id: "m2", role: "assistant", content: [{ type: "text", text: "It is empty." }] },
  },
];

describe("a subagent's file", () => {
  test("is the lines of its Agent call: its replies and its tools' results, not its prompt", () => {
    const lines = subagentLines(SUBAGENT, "toolu_agent");
    expect(lines.map((line) => (line.message as { type: string }).type)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    for (const line of lines) {
      expect((line.message as { parent_tool_use_id: string }).parent_tool_use_id).toBe(
        "toolu_agent",
      );
    }
  });

  test("makes the subagent's messages and its calls, under its Agent call", () => {
    const log = subagentLog(SUBAGENT, "toolu_agent");
    expect(
      log.items.map((item) =>
        item.blocks.map((b) =>
          b.type === "text" ? b.text : `${b.type}:${"toolUseId" in b ? b.toolUseId : ""}`,
        ),
      ),
    ).toEqual([["Reading it.", "tool:read1"], ["It is empty."]]);
    expect(log.items[0]?.at).toBe(Date.parse("2026-11-17T01:00:05.000Z"));
    expect(log.tools.read1).toMatchObject({
      name: "Read",
      status: "done",
      parentToolUseId: "toolu_agent",
    });
    expect(log.tools.read1?.result?.text).toContain("export {}");
  });

  test("goes in the history, which keeps what it had", () => {
    const history = historyModel(ENTRIES);
    const log = subagentLog(SUBAGENT, "toolu_agent");
    const joined = withSubagentLog(history, "toolu_agent", log);
    expect(joined.items).toBe(history.items);
    expect(joined.agentItems.toolu_agent).toBe(log.items);
    expect(joined.tools.read1).toBe(log.tools.read1);
    // A tab with no history has one for it.
    const alone = withSubagentLog(null, "toolu_agent", log);
    expect(alone.items).toEqual([]);
    expect(alone.agentItems.toolu_agent).toBe(log.items);
  });

  test("is found by the agent id its call's result names", () => {
    const tool = (structured: unknown) => ({
      id: "t",
      name: "Agent",
      input: {},
      status: "done" as const,
      parentToolUseId: null,
      result: { text: "", isError: false, images: [], structured },
    });
    expect(subagentIdOf(tool({ status: "completed", agentId: "a1b2" }))).toBe("a1b2");
    expect(subagentIdOf(tool({ agent_id: "teammate-1" }))).toBe("teammate-1");
    expect(subagentIdOf(tool({ status: "completed" }))).toBeUndefined();
    expect(subagentIdOf(undefined)).toBeUndefined();
  });

  test("a joined history keeps the subagents' messages of both", () => {
    const log = subagentLog(SUBAGENT, "toolu_agent");
    const before = withSubagentLog(historyModel(ENTRIES), "toolu_agent", log);
    const after = { ...emptyModel(), agentItems: { other: log.items } };
    expect(Object.keys(joinHistory(before, after).agentItems).sort()).toEqual([
      "other",
      "toolu_agent",
    ]);
  });
});

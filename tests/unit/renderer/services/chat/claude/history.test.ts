import { describe, expect, test } from "bun:test";
import {
  cutEntries,
  type HistoryCut,
  historyForDisplay,
  historyModel,
  joinHistory,
  modelBefore,
  modelUuids,
  sessionTitleOf,
  subagentIdOf,
  subagentLines,
  subagentLog,
  transcriptGoal,
  transcriptLines,
  uuidBefore,
  withSubagentLog,
} from "../../../../../../src/renderer/services/chat/claude/history";
import {
  applyLines,
  applyTranscriptLines,
} from "../../../../../../src/renderer/services/chat/claude/stream-model";
import { TranscriptPages } from "../../../../../../src/renderer/services/chat/claude/transcript-pages";
import { emptyModel } from "../../../../../../src/renderer/services/chat/model";

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

test("transcript reconstruction agrees with replay for a mixed conversation and its cuts", () => {
  const entries = [
    ...ENTRIES,
    { type: "queue-operation", operation: "enqueue", content: "never delivered" },
    {
      type: "attachment",
      uuid: "attachment-id",
      attachment: {
        type: "queued_command",
        commandMode: "prompt",
        source_uuid: "queued-user",
        prompt: "read while a turn ran",
      },
    },
    {
      type: "assistant",
      uuid: "call",
      message: {
        id: "m3",
        content: [{ type: "tool_use", id: "read1", name: "Read", input: { file_path: "/p/a" } }],
      },
    },
    {
      type: "assistant",
      uuid: "sidechain",
      isSidechain: true,
      message: { id: "worker", content: [{ type: "text", text: "subagent only" }] },
    },
    {
      type: "user",
      uuid: "tool-result",
      message: { content: [{ type: "tool_result", tool_use_id: "read1", content: "file body" }] },
    },
    {
      type: "attachment",
      timestamp: "2026-11-10T13:52:53.172Z",
      attachment: { type: "goal_status", met: true, condition: "green tests", reason: "all pass" },
    },
    { type: "custom-title", customTitle: "  Mixed history  " },
    { type: "ai-title", aiTitle: "Generated title" },
  ];

  // Keep the general log reducer as the reference for the transcript path.
  const cuts: (HistoryCut | undefined)[] = [
    undefined,
    { upTo: "queued-user" },
    { upTo: "tool-result" },
    { before: new Set(["queued-user", "call"]) },
  ];
  for (const cut of cuts) {
    const lines = transcriptLines(cut ? cutEntries(entries, cut) : entries);
    const replay = applyLines(emptyModel(), lines);
    expect(historyModel(entries, cut)).toStrictEqual({
      ...replay,
      running: false,
      turn: null,
      streaming: null,
      permissions: [],
    });
  }

  const history = historyModel(entries);
  expect([...modelUuids(history)]).toEqual(["u1", "a1", "u2", "a2", "queued-user", "call"]);
  expect(uuidBefore(history, "queued-user")).toBe("a2");
  expect(history.tools.read1).toMatchObject({
    name: "Read",
    status: "done",
    result: { text: "file body" },
  });
  expect(history.goal).toMatchObject({ status: "met", condition: "green tests" });
  expect(transcriptGoal(entries)).toEqual(history.goal);
  expect(sessionTitleOf(entries)).toBe("Mixed history");
});

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

  test("a compaction reads as a notice, and its summary is not the user's message", () => {
    const entries = [
      { type: "user", uuid: "u1", message: { role: "user", content: "one" } },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        type: "user",
        uuid: "s1",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context.",
        },
      },
      { type: "user", uuid: "u2", message: { role: "user", content: "two" } },
    ];
    const items = applyTranscriptLines(transcriptLines(entries)).items;
    expect(items.map((i) => i.kind)).toEqual(["user", "notice", "user"]);
    expect(JSON.stringify(items)).not.toContain("being continued");
  });

  test("a compaction the user ran shows its command first, then the notice, as live", () => {
    const entries = [
      { type: "user", uuid: "u1", message: { role: "user", content: "one" } },
      { type: "system", subtype: "compact_boundary", uuid: "b1" },
      {
        type: "user",
        uuid: "s1",
        isCompactSummary: true,
        message: { role: "user", content: "This session is being continued from a previous one." },
      },
      {
        type: "user",
        uuid: "c0",
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" },
      },
      {
        type: "user",
        uuid: "c1",
        message: {
          role: "user",
          content:
            "<command-name>/compact</command-name><command-message>compact</command-message><command-args>keep tests</command-args>",
        },
      },
      {
        type: "user",
        uuid: "c2",
        message: {
          role: "user",
          content: "<local-command-stdout>Compacted </local-command-stdout>",
        },
      },
      { type: "attachment", uuid: "x1" },
      { type: "user", uuid: "u2", message: { role: "user", content: "two" } },
    ];
    const items = applyTranscriptLines(
      transcriptLines(
        entries,
        entries.map((_, i) => i * 100),
      ),
    ).items;
    expect(items.map((i) => i.kind)).toEqual(["user", "user", "notice", "user"]);
    expect((items[1] as { text?: string }).text).toBe("/compact keep tests");
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

test("a bounded row split at a UTF-8 boundary is rebuilt before projecting its tool", () => {
  const entry = {
    type: "assistant",
    uuid: "callSliced",
    message: {
      id: "messageSliced",
      content: [{ type: "tool_use", id: "sliced", name: "Read", input: { file_path: "한글" } }],
    },
  };
  const wire = Buffer.from(JSON.stringify(entry));
  const boundary = wire.indexOf(Buffer.from("한")) + 1;
  const base = { found: true, snapshot: "example", truncated: false, lines: [], positions: [] };
  const history = new TranscriptPages(
    {
      ...base,
      cursor: "remaining-fragment",
      fragment: {
        position: 0,
        data: wire.subarray(boundary).toString("base64"),
        first: false,
        last: true,
      },
    },
    base.snapshot,
  );
  expect(history.project().items).toEqual([]);
  history.prepend({
    ...base,
    fragment: {
      position: 0,
      data: wire.subarray(0, boundary).toString("base64"),
      first: true,
      last: false,
    },
  });
  expect(history.lines).toEqual([entry]);
  const projected = history.project();
  expect(projected.tools).toEqual(historyModel([entry]).tools);
  expect(historyForDisplay(projected).tools.sliced).toMatchObject({
    name: "Read",
    status: "stopped",
    input: { file_path: "한글" },
  });
});

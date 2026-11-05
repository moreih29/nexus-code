import { describe, expect, test } from "bun:test";
import {
  cutEntries,
  historyModel,
  joinHistory,
  modelBefore,
  modelUuids,
  sessionTitleOf,
  uuidBefore,
} from "../../../../../src/renderer/services/chat/history";

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
});

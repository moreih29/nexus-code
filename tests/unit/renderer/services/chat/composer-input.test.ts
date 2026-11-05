import { describe, expect, test } from "bun:test";
import {
  applyCompletion,
  completionAt,
  fileMention,
  matchCommands,
  splitAttachments,
} from "../../../../../src/renderer/services/chat/composer-input";

describe("composer completion", () => {
  test("a command only at the start of the message", () => {
    expect(completionAt("/comp", 5)).toEqual({ kind: "command", start: 0, end: 5, query: "comp" });
    expect(completionAt("/", 1)).toEqual({ kind: "command", start: 0, end: 1, query: "" });
    expect(completionAt("/compact now", 12)).toBeNull();
    expect(completionAt("see /comp", 9)).toBeNull();
  });

  test("a file after an @ that starts a word", () => {
    expect(completionAt("look at @src/ap", 15)).toEqual({
      kind: "file",
      start: 8,
      end: 15,
      query: "src/ap",
    });
    expect(completionAt("@", 1)).toEqual({ kind: "file", start: 0, end: 1, query: "" });
    expect(completionAt('@"my fi', 7)).toEqual({ kind: "file", start: 0, end: 7, query: "my fi" });
    expect(completionAt("mail me@example", 15)).toBeNull();
    // In the middle of a word, nothing.
    expect(completionAt("@src/app.ts", 3)).toBeNull();
    expect(completionAt("@src next", 4)).toEqual({ kind: "file", start: 0, end: 4, query: "src" });
  });

  test("commands match their names and aliases, starts first", () => {
    const commands = [
      { name: "compact" },
      { name: "context" },
      { name: "autocompact" },
      { name: "code-review", aliases: ["review"] },
      { name: "__remote-workflow" },
    ];
    expect(matchCommands(commands, "comp").map((c) => c.name)).toEqual(["compact", "autocompact"]);
    expect(matchCommands(commands, "rev").map((c) => c.name)).toEqual(["code-review"]);
    expect(matchCommands(commands, "").map((c) => c.name)).toEqual([
      "compact",
      "context",
      "autocompact",
      "code-review",
    ]);
  });

  test("a pick replaces the token", () => {
    const command = completionAt("/comp", 5);
    if (!command) throw new Error("no completion");
    expect(applyCompletion("/comp", command, { kind: "command", name: "compact" })).toEqual({
      text: "/compact ",
      caret: 9,
    });
    const file = completionAt("fix @sr please", 7);
    if (!file) throw new Error("no completion");
    expect(applyCompletion("fix @sr please", file, { kind: "file", path: "src/app.ts" })).toEqual({
      text: "fix @src/app.ts please",
      caret: 16,
    });
    // A folder stays open for its files.
    expect(applyCompletion("fix @sr please", file, { kind: "file", path: "src/" })).toEqual({
      text: "fix @src/ please",
      caret: 9,
    });
    expect(fileMention("my notes.md")).toBe('@"my notes.md"');
  });

  test("a sent message's attachments are its last paragraph of mentions", () => {
    expect(splitAttachments('What is in it?\n\n@"/a/my note.txt" @/b/c.png')).toEqual({
      text: "What is in it?",
      files: ["/a/my note.txt", "/b/c.png"],
    });
    expect(splitAttachments("@/a/b.txt")).toEqual({ text: "", files: ["/a/b.txt"] });
    expect(splitAttachments("Look at @src/app.ts please")).toEqual({
      text: "Look at @src/app.ts please",
      files: [],
    });
  });
});
